import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Button, Tooltip, message } from 'antd'
import {
  CloseOutlined,
  EyeInvisibleOutlined,
  MinusOutlined,
  RobotOutlined
} from '@ant-design/icons'
import type { BiliContext, NoteEntry, OverlaySnapshot, OverlayState } from '../../../shared/bili'
import type { TimerSnapshot } from '../../../shared/types'
import ChatPane from './ChatPane'
import NotesPane from './NotesPane'
import ProgressPane from './ProgressPane'
import { useProgressStore } from '../store/progressStore'
import { useAiChat } from '../hooks/useAiChat'
import { useNotes } from '../hooks/useNotes'

/**
 * 全屏悬浮面板（#overlay 路由，透明置顶窗口内运行）—— 学习助手重构版：
 * - 状态机 3 态：expanded / minimized / hidden（主进程窗口状态为唯一事实源）
 * - 展开态改「对话 / 笔记 / 进度」三页签（I-1）
 * - AI 问答与笔记逻辑已抽到共享 hook useAiChat / useNotes（H-07/H-09：
 *   与学习助手抽屉复用，消除重复；本组件只做窗口状态 + 页签编排 + 计时/进度撮合）
 */

type OverlayTab = 'chat' | 'notes' | 'progress'
type Phase = OverlayState

interface OverlayUiState {
  phase: Phase
  canMinimize: boolean
  context: BiliContext | null
  tab: OverlayTab
  // 会话计时（进度数据已迁入 progressStore）
  sessionRatio: number
  sessionActive: boolean
}

type Action =
  | { type: 'snapshot'; snapshot: OverlaySnapshot }
  | { type: 'set-context'; context: BiliContext | null }
  | { type: 'set-tab'; tab: OverlayTab }
  | { type: 'session-tick'; ratio: number; active: boolean }

const initialState: OverlayUiState = {
  phase: 'expanded',
  canMinimize: true,
  context: null,
  tab: 'chat',
  sessionRatio: 0,
  sessionActive: false
}

function reducer(state: OverlayUiState, action: Action): OverlayUiState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, phase: action.snapshot.state, canMinimize: action.snapshot.canMinimize }
    case 'set-context':
      return { ...state, context: action.context }
    case 'set-tab':
      return { ...state, tab: action.tab }
    case 'session-tick':
      return { ...state, sessionRatio: action.ratio, sessionActive: action.active }
  }
}

function OverlayApp(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)

  // 上下文 ref：供共享 hook 的稳定 getContext 读取最新值
  const contextRef = useRef<BiliContext | null>(state.context)
  contextRef.current = state.context
  const getContext = useCallback(() => contextRef.current, [])

  // H-07：AI 问答与笔记逻辑复用共享 hook（悬浮面板 source='overlay'）
  const { aiLog, aiInput, asking, setAiInput, setWelcome, askAi, logRef } = useAiChat({
    requestIdPrefix: 'bili',
    getContext
  })
  const {
    notes,
    noteDraft,
    editingNoteId,
    noteDirty,
    loadNotes,
    setDraft,
    newNote,
    selectNote,
    deleteNote,
    toggleKey,
    addSavedNote,
    saveReplyToNotes
  } = useNotes({ source: 'overlay', getContext })

  /* ===== 初始化：主进程状态快照 + 状态广播订阅 ===== */
  useEffect(() => {
    void window.api.bili
      .overlayGetState()
      .then((snapshot) => dispatch({ type: 'snapshot', snapshot }))
      .catch((err) => console.error('[overlay] 获取状态失败:', err))
    const off = window.api.on<OverlaySnapshot>(
      window.api.events.bili.overlayStateChanged,
      (snapshot) => {
        dispatch({ type: 'snapshot', snapshot })
      }
    )
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
      setWelcome(lines.join('\n'))
    })
  }, [setWelcome])

  /* ===== 初始化：载入当前视频笔记（F-1 按视频归档） ===== */
  useEffect(() => {
    void loadNotes(state.context?.bvid)
  }, [state.context?.bvid, loadNotes])

  /* ===== 初始化：会话计时（进度数据由 progressStore 管理） ===== */
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

  /* ===== M3 进度撮合：会话进行中每 5 秒累计观看时长 + 刷新播放位置/总时长 ===== */
  useEffect(() => {
    const bvid = state.context?.bvid
    if (!state.sessionActive || !bvid) return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const store = useProgressStore.getState()
          const current = store.all.find((r) => r.bvid === bvid)
          const needDuration = !current || current.durationS <= 0
          const [positionS, durationS] = await Promise.all([
            window.api.bili.getVideoPosition(),
            needDuration ? window.api.bili.getVideoDuration() : Promise.resolve(0)
          ])
          const rec = await window.api.playRecords.tick({
            bvid,
            watchedDeltaS: 5,
            positionS,
            durationS: durationS > 0 ? durationS : undefined
          })
          if (rec) store.applyTick(rec)
        } catch {
          /* 忽略单次心跳失败 */
        }
      })()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [state.sessionActive, state.context?.bvid])

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

  /** F-2 时间点标记：读取播放器当前位置（HTML5 标准 API）并落一条重点 */
  const handleMarkKeyPoint = async (): Promise<void> => {
    const ctx = state.context
    if (!ctx?.bvid) return
    try {
      const position = await window.api.bili.getVideoPosition()
      const entry: NoteEntry = {
        id: `k-${Date.now()}`,
        createdAt: Date.now(),
        content: position > 0 ? `⏱ 重点标记 @ ${formatClock(position)}` : '重点标记',
        bvid: ctx.bvid,
        videoTitle: ctx.videoTitle,
        timestampS: position > 0 ? position : undefined,
        isKey: true,
        source: 'time-mark'
      }
      const saved = await window.api.notes.upsert(entry)
      addSavedNote(saved)
      // 同步进度记录的上次位置（"回到上次位置"可用；走 progressStore 本地即时更新）
      if (position > 0) {
        void window.api.playRecords
          .tick({ bvid: ctx.bvid, watchedDeltaS: 0, positionS: position })
          .then((rec) => {
            if (rec) useProgressStore.getState().applyTick(rec)
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
    const ctx = state.context
    if (!ctx?.bvid) return
    void window.api.bili
      .seekTo({ bvid: ctx.bvid, seconds })
      .catch((err) =>
        message.error(`跳转失败: ${err instanceof Error ? err.message : String(err)}`)
      )
  }

  const closeVideo = (): void => {
    void window.api.bili
      .closeVideo()
      .catch((err) => console.error('[overlay] 关闭视频窗口失败:', err))
  }

  /* ===== minimized / hidden 窗口本身不可见，无需渲染内容 ===== */
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
          笔记{noteDirty ? ' ●' : ''}
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
            log={aiLog}
            input={aiInput}
            asking={asking}
            logRef={logRef}
            onInput={setAiInput}
            onSend={() => void askAi()}
            onSaveToNotes={saveReplyToNotes}
          />
        )}
        {state.tab === 'notes' && (
          <NotesPane
            notes={notes}
            draft={noteDraft}
            editingId={editingNoteId}
            context={state.context}
            onDraftChange={(v) => setDraft(v)}
            onNewNote={newNote}
            onSelectNote={selectNote}
            onDeleteNote={deleteNote}
            onToggleKey={toggleKey}
            onMarkKeyPoint={() => void handleMarkKeyPoint()}
            onSeek={handleSeek}
          />
        )}
        {state.tab === 'progress' && (
          <ProgressPane bvid={state.context?.bvid} onSeek={handleSeek} />
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
