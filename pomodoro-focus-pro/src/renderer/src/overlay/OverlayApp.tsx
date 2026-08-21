import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Button, Tooltip, message } from 'antd'
import {
  CloseOutlined,
  EyeInvisibleOutlined,
  MinusOutlined,
  RobotOutlined
} from '@ant-design/icons'
import type {
  AiMessage,
  BiliContext,
  NoteEntry,
  OverlaySnapshot,
  OverlayState
} from '../../../shared/bili'
import type { AiStreamChunk } from '../../../shared/ai'
import type { PlayRecord } from '../../../shared/stats'
import type { TimerSnapshot } from '../../../shared/types'
import ScrollArea, { type ScrollAreaHandle } from '../components/ScrollArea'
import ChatPane, { type ChatMsg } from './ChatPane'
import NotesPane from './NotesPane'
import ProgressPane from './ProgressPane'

/**
 * 全屏悬浮面板（#overlay 路由，透明置顶窗口内运行）—— 学习助手重构版：
 * - 状态机 3 态：expanded / minimized / hidden（主进程窗口状态为唯一事实源；已删除 collapsed 悬浮球态）
 * - 展开态 610×940，可拖拽 header 移动、可最小化（L0/L1）、最小窗口 610×940
 * - 展开态改「对话 / 笔记 / 进度」三页签（I-1），长对话与长笔记互不挤压
 * - AI 问答流式渲染（F-4/P-2，ai:bili-ask + ai:chunk），回答可「一键记入笔记」（I-4）
 * - 笔记按视频归档 + 增量 upsert（F-1/P-1）+ 重点标记（F-2）+ 时间点标记/跳转（F-2）
 * - 进度页签（F-3）：当前视频「已看/总时长·进度·看过几遍」+ 学习目标（F-5）
 * - 视频标题注入 AI 上下文（I-2），对话问候语说出正在看的视频
 */

type OverlayTab = 'chat' | 'notes' | 'progress'
type Phase = OverlayState

interface OverlayUiState {
  phase: Phase
  canMinimize: boolean
  context: BiliContext | null
  tab: OverlayTab
  aiInput: string
  aiLog: ChatMsg[]
  activeRequestId: string | null
  asking: boolean
  // 笔记
  notes: NoteEntry[]
  noteDraft: string
  editingNoteId: string | null
  noteDirty: boolean
  // 进度
  progress: PlayRecord | null
  allProgress: PlayRecord[]
  sessionRatio: number
  sessionActive: boolean
}

type Action =
  | { type: 'snapshot'; snapshot: OverlaySnapshot }
  | { type: 'set-context'; context: BiliContext | null }
  | { type: 'welcome'; message: string }
  | { type: 'set-tab'; tab: OverlayTab }
  | { type: 'set-ai-input'; value: string }
  | { type: 'ask-start'; requestId: string; text: string }
  | { type: 'ask-chunk'; requestId: string; delta: string }
  | { type: 'ask-done'; requestId: string; content: string }
  | { type: 'ask-fail'; requestId: string; message: string }
  | { type: 'set-notes'; notes: NoteEntry[] }
  | { type: 'set-note-draft'; draft: string; dirty: boolean }
  | { type: 'note-upserted'; entry: NoteEntry }
  /** 自动保存落盘完成：合并列表 + 仅草稿未变时回填/清 dirty（请求期间用户继续输入则保留新草稿） */
  | { type: 'note-save-settled'; entry: NoteEntry; savedDraft: string }
  | { type: 'note-attach-id'; id: string }
  | { type: 'note-removed'; id: string }
  | { type: 'set-progress'; current: PlayRecord | null; all: PlayRecord[] }
  | { type: 'progress-tick'; record: PlayRecord }
  | { type: 'session-tick'; ratio: number; active: boolean }

const initialState: OverlayUiState = {
  phase: 'expanded',
  canMinimize: true,
  context: null,
  tab: 'chat',
  aiInput: '',
  aiLog: [],
  activeRequestId: null,
  asking: false,
  notes: [],
  noteDraft: '',
  editingNoteId: null,
  noteDirty: false,
  progress: null,
  allProgress: [],
  sessionRatio: 0,
  sessionActive: false
}

function reducer(state: OverlayUiState, action: Action): OverlayUiState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, phase: action.snapshot.state, canMinimize: action.snapshot.canMinimize }
    case 'set-context':
      return { ...state, context: action.context }
    case 'welcome':
      return { ...state, aiLog: [{ id: 'welcome', role: 'assistant', content: action.message, welcome: true }] }
    case 'set-tab':
      return { ...state, tab: action.tab }
    case 'set-ai-input':
      return { ...state, aiInput: action.value }
    case 'ask-start':
      return {
        ...state,
        asking: true,
        activeRequestId: action.requestId,
        aiInput: '',
        aiLog: [
          ...state.aiLog,
          { id: `u-${action.requestId}`, role: 'user', content: action.text },
          { id: action.requestId, role: 'assistant', content: '', streaming: true }
        ]
      }
    case 'ask-chunk': {
      if (state.activeRequestId !== action.requestId) return state
      return {
        ...state,
        aiLog: state.aiLog.map((m) =>
          m.id === action.requestId && m.streaming ? { ...m, content: m.content + action.delta } : m
        )
      }
    }
    case 'ask-done': {
      if (state.activeRequestId !== action.requestId) return state
      return {
        ...state,
        asking: false,
        activeRequestId: null,
        aiLog: state.aiLog.map((m) =>
          m.id === action.requestId ? { id: m.id, role: 'assistant', content: action.content } : m
        )
      }
    }
    case 'ask-fail': {
      if (state.activeRequestId !== action.requestId) return state
      return {
        ...state,
        asking: false,
        activeRequestId: null,
        aiLog: state.aiLog.map((m) =>
          m.id === action.requestId
            ? { id: m.id, role: 'assistant', content: `AI 调用失败：${action.message}` }
            : m
        )
      }
    }
    case 'set-notes':
      return { ...state, notes: action.notes }
    case 'set-note-draft':
      return { ...state, noteDraft: action.draft, noteDirty: action.dirty }
    case 'note-upserted': {
      const exists = state.notes.some((n) => n.id === action.entry.id)
      return {
        ...state,
        notes: exists
          ? state.notes.map((n) => (n.id === action.entry.id ? action.entry : n))
          : [action.entry, ...state.notes]
      }
    }
    case 'note-save-settled': {
      const exists = state.notes.some((n) => n.id === action.entry.id)
      const notes = exists
        ? state.notes.map((n) => (n.id === action.entry.id ? action.entry : n))
        : [action.entry, ...state.notes]
      // 请求期间用户继续输入（草稿已变）：保留新草稿与 dirty 状态，仅更新列表，
      // 避免回填旧内容覆盖输入、并误清 dirty 导致后续改动不再自动保存
      const draftChanged = state.noteDraft !== action.savedDraft
      return {
        ...state,
        notes,
        noteDraft: draftChanged ? state.noteDraft : action.entry.content,
        noteDirty: draftChanged ? state.noteDirty : false,
        // 新笔记首次落盘（editingNoteId 为空）时挂接稳定 id；用户已切换到其他笔记则不覆盖
        editingNoteId: state.editingNoteId ?? action.entry.id
      }
    }
    case 'note-attach-id':
      return { ...state, editingNoteId: action.id }
    case 'note-removed':
      return { ...state, notes: state.notes.filter((n) => n.id !== action.id) }
    case 'set-progress':
      return { ...state, progress: action.current, allProgress: action.all }
    case 'progress-tick':
      return {
        ...state,
        progress: action.record,
        allProgress: state.allProgress.some((r) => r.bvid === action.record.bvid)
          ? state.allProgress.map((r) => (r.bvid === action.record.bvid ? action.record : r))
          : [action.record, ...state.allProgress]
      }
    case 'session-tick':
      return { ...state, sessionRatio: action.ratio, sessionActive: action.active }
  }
}

function OverlayApp(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  const logRef = useRef<ScrollAreaHandle>(null)
  const persistTimer = useRef<number | null>(null)
  /** 最新 state 镜像：供 useCallback([]) 内的异步流程读取最新值（闭包里的 state 已过期） */
  const stateRef = useRef<OverlayUiState>(state)
  useEffect(() => {
    stateRef.current = state
  })

  /* ===== 初始化：主进程状态快照 + 状态广播订阅 ===== */
  useEffect(() => {
    void window.api.bili
      .overlayGetState()
      .then((snapshot) => dispatch({ type: 'snapshot', snapshot }))
      .catch((err) => console.error('[overlay] 获取状态失败:', err))
    const off = window.api.on<OverlaySnapshot>(window.api.events.bili.overlayStateChanged, (snapshot) => {
      dispatch({ type: 'snapshot', snapshot })
    })
    return off
  }, [])

  /* ===== 初始化：学习上下文（含视频标题 I-2）+ 欢迎语 ===== */
  useEffect(() => {
    void window.api.bili.getContext().then((ctx) => {
      dispatch({ type: 'set-context', context: ctx })
      const lines = ['已进入 B 站学习模式。']
      if (ctx?.topic) lines.push(`学习主题「${ctx.topic}」`)
      if (ctx?.videoTitle) lines.push(`正在观看《${ctx.videoTitle}》`)
      lines.push('学习中有疑问随时提问：概念讲解、要点总结、随堂测验都可以。')
      dispatch({ type: 'welcome', message: lines.join('\n') })
    })
  }, [])

  /* ===== 初始化：载入当前视频笔记（F-1 按视频归档） ===== */
  const loadNotes = useCallback(async (bvid?: string): Promise<void> => {
    const prev = stateRef.current
    // bvid 变化且存在未保存草稿：先按旧上下文落盘，避免切换视频丢弃用户输入
    // （自动保存 effect 不依赖 bvid，切换时不会自动触发，必须在此兜底 flush）
    if (prev.noteDirty && prev.noteDraft.trim() && prev.context?.bvid !== bvid) {
      const flushingId = prev.editingNoteId || `n-${Date.now()}`
      const existing = prev.notes.find((n) => n.id === flushingId)
      void window.api.notes
        .upsert({
          id: flushingId,
          createdAt: existing?.createdAt ?? Date.now(),
          content: prev.noteDraft,
          bvid: prev.context?.bvid,
          videoTitle: prev.context?.videoTitle,
          source: 'overlay'
        })
        .then((saved) => dispatch({ type: 'note-upserted', entry: saved }))
        .catch(() => {
          /* 落盘失败不阻塞载入 */
        })
    }
    try {
      const notes = bvid ? await window.api.notes.loadByVideo(bvid) : await window.api.notes.load()
      dispatch({ type: 'set-notes', notes })
      // 聚焦最新一条笔记（若当前未在编辑）
      if (notes.length > 0) {
        const latest = notes[0]
        dispatch({ type: 'note-attach-id', id: latest.id })
        dispatch({ type: 'set-note-draft', draft: latest.content, dirty: false })
      }
    } catch (err) {
      console.error('[overlay] 载入笔记失败:', err)
    }
  }, [])

  useEffect(() => {
    void loadNotes(state.context?.bvid)
  }, [state.context?.bvid, loadNotes])

  /* ===== 笔记：500ms 防抖增量自动保存（P-1，单条 upsert） ===== */
  useEffect(() => {
    if (!state.noteDirty) return
    if (persistTimer.current) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      const id = state.editingNoteId || `n-${Date.now()}`
      // 编辑既有笔记时复用原 createdAt（时间点/排序依据），仅新笔记取当前时间
      const existing = state.notes.find((n) => n.id === id)
      const savedDraft = state.noteDraft
      const entry: NoteEntry = {
        id,
        createdAt: existing?.createdAt ?? Date.now(),
        content: savedDraft,
        bvid: state.context?.bvid,
        videoTitle: state.context?.videoTitle,
        source: 'overlay'
      }
      void window.api.notes
        .upsert(entry)
        .then((saved) => {
          // 收尾判断在 reducer 内基于最新 state 完成（本闭包里的 state 已过期）：
          // 草稿未变才回填/清 dirty；新笔记首存时才挂接稳定 id
          dispatch({ type: 'note-save-settled', entry: saved, savedDraft })
        })
        .catch((err) => console.error('[overlay] 笔记保存失败:', err))
    }, 500)
    return () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.noteDraft, state.noteDirty, state.editingNoteId])

  /* ===== 初始化：学习进度（F-3）+ 会话计时（悬浮球进度环 I-3） ===== */
  const loadProgress = useCallback(async (bvid?: string): Promise<void> => {
    try {
      const all = await window.api.playRecords.list()
      const current = all.find((r) => r.bvid === bvid) ?? null
      dispatch({ type: 'set-progress', current, all })
    } catch (err) {
      console.error('[overlay] 载入学习进度失败:', err)
    }
  }, [])

  useEffect(() => {
    void loadProgress(state.context?.bvid)
  }, [state.context?.bvid, loadProgress])

  useEffect(() => {
    void window.api.session
      .getState()
      .then((st) => {
        const snap = st.timer
        dispatch({
          type: 'session-tick',
          ratio: snap.durationMs > 0 ? snap.remainingMs / snap.durationMs : 0,
          active: snap.status === 'running' || snap.status === 'paused'
        })
      })
      .catch(() => {
        /* 忽略 */
      })
    const off = window.api.on<TimerSnapshot>(window.api.events.session.tick, (snap) => {
      dispatch({
        type: 'session-tick',
        ratio: snap.durationMs > 0 ? snap.remainingMs / snap.durationMs : 0,
        active: snap.status === 'running' || snap.status === 'paused'
      })
    })
    return off
  }, [])

  /* ===== F-3 学习进度撮合：会话进行中每 5 秒累计一次观看时长（会话级，不逐帧跟踪） ===== */
  useEffect(() => {
    const bvid = state.context?.bvid
    if (!state.sessionActive || !bvid) return
    const timer = window.setInterval(() => {
      void window.api.playRecords
        .tick({ bvid, watchedDeltaS: 5, positionS: 0 })
        .then((rec) => {
          if (rec) dispatch({ type: 'progress-tick', record: rec })
        })
        .catch(() => {
          /* 忽略 */
        })
    }, 5000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sessionActive, state.context?.bvid])

  /* ===== AI 对话自动滚动到底部：已内聚到 ChatPane（logRef 持有方），本处不再重复 ===== */

  /* ===== 状态切换（主进程为事实源，快照回填 UI） ===== */
  const requestPhase = (next: Phase): void => {
    void window.api.bili
      .overlaySetState(next)
      .then((snapshot) => {
        dispatch({ type: 'snapshot', snapshot })
        if (snapshot.notice) message.warning(snapshot.notice)
      })
      .catch((err) => console.error('[overlay] 状态切换失败:', err))
  }

  const minimize = (): void => requestPhase('minimized')
  const hide = (): void => requestPhase('hidden')

  /* ===== AI 流式问答（F-4/P-2）：ai:bili-ask + ai:chunk 关联 requestId ===== */
  const askAi = async (): Promise<void> => {
    const text = state.aiInput.trim()
    if (!text || state.asking) return
    const requestId = `bili-${Date.now()}`
    // 携带最近 8 轮对话（不含本轮提问），主进程注入 messages 保持多轮连贯
    const history: AiMessage[] = state.aiLog
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() && !m.streaming)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }))
    dispatch({ type: 'ask-start', requestId, text })

    const off = window.api.on<AiStreamChunk>(window.api.events.ai.chunk, (chunk) => {
      if (chunk.requestId !== requestId) return
      if (!chunk.done) {
        dispatch({ type: 'ask-chunk', requestId, delta: chunk.delta })
      } else if (chunk.content) {
        dispatch({ type: 'ask-done', requestId, content: chunk.content })
        off()
      }
    })

    try {
      const reply = await window.api.ai.biliAsk({
        requestId,
        message: text,
        context: {
          topic: state.context?.topic ?? undefined,
          bvid: state.context?.bvid ?? undefined,
          videoTitle: state.context?.videoTitle ?? undefined
        },
        history
      })
      dispatch({ type: 'ask-done', requestId, content: reply.content })
    } catch (err) {
      dispatch({ type: 'ask-fail', requestId, message: err instanceof Error ? err.message : String(err) })
    } finally {
      off()
    }
  }

  /* ===== I-4 问答↔笔记联动：AI 回答一键入笔记 ===== */
  const saveReplyToNotes = (msg: ChatMsg): void => {
    if (!msg.content.trim()) return
    const entry: NoteEntry = {
      id: `ai-${Date.now()}`,
      createdAt: Date.now(),
      content: msg.content,
      bvid: state.context?.bvid,
      videoTitle: state.context?.videoTitle,
      source: 'ai'
    }
    void window.api.notes
      .upsert(entry)
      .then((saved) => {
        dispatch({ type: 'note-upserted', entry: saved })
        message.success('AI 回答已存入笔记（可到「笔记」页签查看）')
      })
      .catch((err) => message.error(`存入笔记失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /* ===== 笔记操作（F-1/F-2） ===== */
  const handleNewNote = (): void => {
    dispatch({ type: 'note-attach-id', id: `n-${Date.now()}` })
    dispatch({ type: 'set-note-draft', draft: '', dirty: false })
  }

  /** 切换到另一条笔记：先落盘当前未保存的草稿，避免 500ms 防抖窗口内切换丢失 */
  const handleSelectNote = (entry: NoteEntry): void => {
    if (state.noteDirty && state.noteDraft.trim()) {
      const flushingId = state.editingNoteId || `n-${Date.now()}`
      // 复用既有笔记 createdAt，避免切换落盘把新笔记的创建时间重置为当前时刻
      const existing = state.notes.find((n) => n.id === flushingId)
      void window.api.notes
        .upsert({
          id: flushingId,
          createdAt: existing?.createdAt ?? Date.now(),
          content: state.noteDraft,
          bvid: state.context?.bvid,
          videoTitle: state.context?.videoTitle,
          source: 'overlay'
        })
        .then((saved) => dispatch({ type: 'note-upserted', entry: saved }))
        .catch(() => {
          /* 落盘失败不阻塞切换 */
        })
    }
    dispatch({ type: 'note-attach-id', id: entry.id })
    dispatch({ type: 'set-note-draft', draft: entry.content, dirty: false })
  }

  /** 返回 Promise：NotesPane 等落库结果后再提示成功/失败 */
  const handleDeleteNote = (id: string): Promise<void> => {
    return window.api.notes
      .delete(id)
      .then(() => {
        dispatch({ type: 'note-removed', id })
        if (state.editingNoteId === id) {
          dispatch({ type: 'note-attach-id', id: `n-${Date.now()}` })
          dispatch({ type: 'set-note-draft', draft: '', dirty: false })
        }
      })
  }

  const handleToggleKey = (entry: NoteEntry): void => {
    void window.api.notes
      .upsert({ ...entry, isKey: !entry.isKey })
      .then((saved) => dispatch({ type: 'note-upserted', entry: saved }))
      .catch((err) => message.error(`标记失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /** F-2 时间点标记：读取播放器当前位置（HTML5 标准 API）并落一条重点 */
  const handleMarkKeyPoint = async (): Promise<void> => {
    if (!state.context?.bvid) return
    try {
      const position = await window.api.bili.getVideoPosition()
      const entry: NoteEntry = {
        id: `k-${Date.now()}`,
        createdAt: Date.now(),
        content: position > 0 ? `⏱ 重点标记 @ ${formatClock(position)}` : '重点标记',
        bvid: state.context.bvid,
        videoTitle: state.context.videoTitle,
        timestampS: position > 0 ? position : undefined,
        isKey: true,
        source: 'time-mark'
      }
      const saved = await window.api.notes.upsert(entry)
      dispatch({ type: 'note-upserted', entry: saved })
      // 同步进度记录的上次位置（"回到上次位置"可用）
      if (position > 0) {
        void window.api.playRecords
          .tick({ bvid: state.context.bvid, watchedDeltaS: 0, positionS: position })
          .then((rec) => {
            if (rec) dispatch({ type: 'progress-tick', record: rec })
          })
          .catch(() => {
            /* 忽略 */
          })
      }
      message.success(position > 0 ? `已记录重点 @ ${formatClock(position)}` : '已记录重点')
    } catch (err) {
      message.error(`记录失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** F-2 时间点跳转：让视频 seek 到指定进度 */
  const handleSeek = (seconds: number): void => {
    if (!state.context?.bvid) return
    void window.api.bili
      .seekTo({ bvid: state.context.bvid, seconds })
      .catch((err) => message.error(`跳转失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /* ===== 进度操作（F-3/F-5） ===== */
  const handleMarkDone = (bvid: string): void => {
    void window.api.playRecords
      .markDone(bvid)
      .then(() => loadProgress(state.context?.bvid))
      .then(() => message.success('已标记为学完'))
      .catch((err) => message.error(`操作失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /** 返回 Promise：进度页签等待落库完成后提示（错误由调用方展示） */
  const handleSetGoal = (bvid: string, goalRounds: number, goalDeadline?: string): Promise<void> => {
    return window.api.playRecords
      .setGoal(bvid, goalRounds, goalDeadline)
      .then(() => loadProgress(state.context?.bvid))
      .then(() => undefined)
  }

  const closeVideo = (): void => {
    void window.api.bili.closeVideo().catch((err) => console.error('[overlay] 关闭视频窗口失败:', err))
  }

  /* ===== 悬浮球态已删除（学习助手重构）：minimized / hidden 窗口本身不可见，无需渲染内容 ===== */
  if (state.phase !== 'expanded') {
    return <div className="overlay-root overlay-invisible" />
  }

  /* ===== 展开态：三页签（对话 / 笔记 / 进度） ===== */
  const headerTitle = state.context?.videoTitle ?? state.context?.bvid ?? ''
  return (
    <div className="overlay-root">
      <div className="overlay-header">
        <span className="overlay-title" title={headerTitle}>
          <RobotOutlined /> 学习助手
          {headerTitle && <span className="overlay-video-title">{headerTitle}</span>}
        </span>
        <div className="overlay-header-actions">
          <Tooltip title={state.canMinimize ? '最小化' : '当前锁定等级不支持最小化'}>
            <Button
              type="text"
              size="small"
              icon={<MinusOutlined />}
              disabled={!state.canMinimize}
              onClick={minimize}
            />
          </Tooltip>
          <Tooltip title="隐藏面板（Ctrl+Shift+O 呼出）">
            <Button type="text" size="small" icon={<EyeInvisibleOutlined />} onClick={hide} />
          </Tooltip>
          <Tooltip title="关闭视频，结束学习会话（Ctrl+Shift+Q）">
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={closeVideo} />
          </Tooltip>
        </div>
      </div>

      {/* 页签（I-1） */}
      <div className="overlay-tabs" role="tablist" aria-label="学习助手功能页">
        <button
          type="button"
          role="tab"
          aria-selected={state.tab === 'chat'}
          className={`overlay-tab${state.tab === 'chat' ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'set-tab', tab: 'chat' })}
        >
          对话
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.tab === 'notes'}
          className={`overlay-tab${state.tab === 'notes' ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'set-tab', tab: 'notes' })}
        >
          笔记{state.noteDirty ? ' ●' : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.tab === 'progress'}
          className={`overlay-tab${state.tab === 'progress' ? ' active' : ''}`}
          onClick={() => dispatch({ type: 'set-tab', tab: 'progress' })}
        >
          进度
        </button>
      </div>

      <div className="overlay-body">
        {state.tab === 'chat' && (
          <ChatPane
            log={state.aiLog}
            input={state.aiInput}
            asking={state.asking}
            logRef={logRef}
            onInput={(value) => dispatch({ type: 'set-ai-input', value })}
            onSend={() => void askAi()}
            onSaveToNotes={saveReplyToNotes}
          />
        )}
        {state.tab === 'notes' && (
          <NotesPane
            notes={state.notes}
            draft={state.noteDraft}
            editingId={state.editingNoteId}
            context={state.context}
            onDraftChange={(v) => dispatch({ type: 'set-note-draft', draft: v, dirty: true })}
            onNewNote={handleNewNote}
            onSelectNote={handleSelectNote}
            onDeleteNote={handleDeleteNote}
            onToggleKey={handleToggleKey}
            onMarkKeyPoint={() => void handleMarkKeyPoint()}
            onSeek={handleSeek}
          />
        )}
        {state.tab === 'progress' && (
          <ProgressPane
            current={state.progress}
            all={state.allProgress}
            bvid={state.context?.bvid}
            onMarkDone={handleMarkDone}
            onSetGoal={handleSetGoal}
            onSeek={handleSeek}
            onRefresh={() => void loadProgress(state.context?.bvid)}
          />
        )}
      </div>
    </div>
  )
}

/** 秒 → m:ss / h:mm:ss */
function formatClock(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export default OverlayApp
