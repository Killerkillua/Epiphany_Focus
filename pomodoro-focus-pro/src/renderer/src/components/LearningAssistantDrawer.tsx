import { useCallback, useEffect, useRef, useState } from 'react'
import { Drawer, message } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import type { AiMessage, BiliContext, NoteEntry } from '../../../shared/bili'
import type { AiStreamChunk } from '../../../shared/ai'
import type { PlayRecord } from '../../../shared/stats'
import ScrollArea, { type ScrollAreaHandle } from './ScrollArea'
import ChatPane, { type ChatMsg } from '../overlay/ChatPane'
import NotesPane from '../overlay/NotesPane'
import ProgressPane from '../overlay/ProgressPane'

type AssistantTab = 'chat' | 'notes' | 'progress'

interface LearningAssistantDrawerProps {
  open: boolean
  /** 当前学习主题（搜索关键词），供非视频模式 AI 上下文使用 */
  topic?: string
  onClose(): void
}

/**
 * 学习助手抽屉（问题 3）：B 站学习页顶部导航栏右侧入口。
 * - 非视频模式可用：对话（基于学习主题）/ 笔记（增删改 + 导出 + OCR）/ 进度三页签
 * - 复用 overlay 的 ChatPane / NotesPane / ProgressPane，与视频模式共享 SQLite 数据
 * - 打开视频时由 BiliModePage 自动关闭（与悬浮面板互斥）
 */
function LearningAssistantDrawer({ open, topic, onClose }: LearningAssistantDrawerProps): JSX.Element {
  const [tab, setTab] = useState<AssistantTab>('chat')
  const [context, setContext] = useState<BiliContext | null>(null)

  // 笔记
  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [noteDraft, setNoteDraft] = useState('')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteDirty, setNoteDirty] = useState(false)
  const persistTimer = useRef<number | null>(null)

  // 进度
  const [allProgress, setAllProgress] = useState<PlayRecord[]>([])
  const [progress, setProgress] = useState<PlayRecord | null>(null)

  // 对话
  const [aiLog, setAiLog] = useState<ChatMsg[]>([])
  const [aiInput, setAiInput] = useState('')
  const [asking, setAsking] = useState(false)
  const logRef = useRef<ScrollAreaHandle>(null)

  // OCR
  const [ocrBusy, setOcrBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /* ===== 打开抽屉：加载共享数据（notes / play_records / 上下文） ===== */
  const loadData = useCallback(async (): Promise<void> => {
    try {
      const ctx = await window.api.bili.getContext()
      setContext(ctx)
      // 打开视频时按视频归档加载；非视频模式加载全部笔记（与视频模式共享 SQLite notes 表）
      const list = ctx?.bvid ? await window.api.notes.loadByVideo(ctx.bvid) : await window.api.notes.load()
      setNotes(list)
      if (list.length > 0) {
        const latest = list[0]
        setEditingNoteId(latest.id)
        setNoteDraft(latest.content)
      } else {
        setEditingNoteId(null)
        setNoteDraft('')
      }
      setNoteDirty(false)
      const all = await window.api.playRecords.list()
      setAllProgress(all)
      setProgress(all.find((r) => r.bvid === ctx?.bvid) ?? null)
      // 欢迎语：非视频模式基于学习主题作答
      const lines = ['已打开学习助手。']
      const t = ctx?.topic ?? topic
      if (t) lines.push(`学习主题「${t}」，随时可以提问、记笔记、查进度。`)
      else lines.push('输入学习主题后可基于主题提问；打开视频后自动切换为视频上下文。')
      setAiLog([{ id: 'welcome', role: 'assistant', content: lines.join('\n'), welcome: true }])
    } catch (err) {
      console.error('[assistant-drawer] 数据加载失败:', err)
    }
  }, [topic])

  useEffect(() => {
    if (open) void loadData()
  }, [open, loadData])

  /* ===== 笔记：500ms 防抖增量自动保存（与 overlay 一致，upsert 单条） ===== */
  useEffect(() => {
    if (!noteDirty) return
    if (persistTimer.current) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      const id = editingNoteId || `n-${Date.now()}`
      const entry: NoteEntry = {
        id,
        createdAt: Date.now(),
        content: noteDraft,
        bvid: context?.bvid,
        videoTitle: context?.videoTitle,
        source: 'main'
      }
      void window.api.notes
        .upsert(entry)
        .then((saved) => {
          setNotes((prev) =>
            prev.some((n) => n.id === saved.id) ? prev.map((n) => (n.id === saved.id ? saved : n)) : [saved, ...prev]
          )
          setNoteDraft(saved.content)
          setNoteDirty(false)
          if (!editingNoteId) setEditingNoteId(saved.id)
        })
        .catch((err) => console.error('[assistant-drawer] 笔记保存失败:', err))
    }, 500)
    return () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteDraft, noteDirty, editingNoteId])

  /* ===== AI 流式问答（复用 ai:bili-ask + ai:chunk；无 bvid 时基于学习主题降级） ===== */
  const askAi = async (): Promise<void> => {
    const text = aiInput.trim()
    if (!text || asking) return
    const requestId = `drawer-${Date.now()}`
    const history: AiMessage[] = aiLog
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() && !m.streaming)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }))
    setAiLog((prev) => [
      ...prev,
      { id: `u-${requestId}`, role: 'user', content: text },
      { id: requestId, role: 'assistant', content: '', streaming: true }
    ])
    setAiInput('')
    setAsking(true)

    const off = window.api.on<AiStreamChunk>(window.api.events.ai.chunk, (chunk) => {
      if (chunk.requestId !== requestId) return
      if (!chunk.done) {
        setAiLog((prev) =>
          prev.map((m) => (m.id === requestId && m.streaming ? { ...m, content: m.content + chunk.delta } : m))
        )
      } else if (chunk.content) {
        const content = chunk.content
        setAiLog((prev) => prev.map((m) => (m.id === requestId ? { id: m.id, role: 'assistant', content } : m)))
        off()
      }
    })

    try {
      const reply = await window.api.ai.biliAsk({
        requestId,
        message: text,
        context: {
          topic: context?.topic ?? topic,
          bvid: context?.bvid ?? undefined,
          videoTitle: context?.videoTitle ?? undefined
        },
        history
      })
      setAiLog((prev) => prev.map((m) => (m.id === requestId ? { id: m.id, role: 'assistant', content: reply.content } : m)))
    } catch (err) {
      setAiLog((prev) =>
        prev.map((m) =>
          m.id === requestId ? { id: m.id, role: 'assistant', content: `AI 调用失败：${err instanceof Error ? err.message : String(err)}` } : m
        )
      )
    } finally {
      off()
      setAsking(false)
    }
  }

  /** I-4：AI 回答一键存入笔记 */
  const saveReplyToNotes = (msg: ChatMsg): void => {
    if (!msg.content.trim()) return
    const entry: NoteEntry = {
      id: `ai-${Date.now()}`,
      createdAt: Date.now(),
      content: msg.content,
      bvid: context?.bvid,
      videoTitle: context?.videoTitle,
      source: 'ai'
    }
    void window.api.notes
      .upsert(entry)
      .then((saved) => {
        setNotes((prev) => [saved, ...prev])
        message.success('AI 回答已存入笔记（可到「笔记」页签查看）')
      })
      .catch((err) => message.error(`存入笔记失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /* ===== 笔记操作 ===== */
  const handleNewNote = (): void => {
    setEditingNoteId(`n-${Date.now()}`)
    setNoteDraft('')
    setNoteDirty(false)
  }

  const handleSelectNote = (entry: NoteEntry): void => {
    // 先落盘当前未保存草稿，避免 500ms 防抖窗口内切换丢失
    if (noteDirty && noteDraft.trim()) {
      void window.api.notes
        .upsert({
          id: editingNoteId || `n-${Date.now()}`,
          createdAt: Date.now(),
          content: noteDraft,
          bvid: context?.bvid,
          videoTitle: context?.videoTitle,
          source: 'main'
        })
        .then((saved) => setNotes((prev) => (prev.some((n) => n.id === saved.id) ? prev.map((n) => (n.id === saved.id ? saved : n)) : [saved, ...prev])))
        .catch(() => {
          /* 落盘失败不阻塞切换 */
        })
    }
    setEditingNoteId(entry.id)
    setNoteDraft(entry.content)
    setNoteDirty(false)
  }

  const handleDeleteNote = (id: string): void => {
    void window.api.notes
      .delete(id)
      .then(() => {
        setNotes((prev) => prev.filter((n) => n.id !== id))
        if (editingNoteId === id) {
          setEditingNoteId(null)
          setNoteDraft('')
          setNoteDirty(false)
        }
      })
      .catch((err) => message.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  const handleToggleKey = (entry: NoteEntry): void => {
    void window.api.notes
      .upsert({ ...entry, isKey: !entry.isKey })
      .then((saved) => setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n))))
      .catch((err) => message.error(`标记失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /** F-2 时间点跳转：视频模式有效；非视频模式提示先打开视频 */
  const handleSeek = (seconds: number): void => {
    if (!context?.bvid) {
      message.info('需先打开对应视频才能跳转到时间点')
      return
    }
    void window.api.bili
      .seekTo({ bvid: context.bvid, seconds })
      .catch((err) => message.error(`跳转失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /* ===== 进度操作 ===== */
  const handleMarkDone = (bvid: string): void => {
    void window.api.playRecords
      .markDone(bvid)
      .then(() => loadData())
      .then(() => message.success('已标记为学完'))
      .catch((err) => message.error(`操作失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  const handleSetGoal = (bvid: string, goalRounds: number, goalDeadline?: string): void => {
    void window.api.playRecords
      .setGoal(bvid, goalRounds, goalDeadline)
      .then(() => loadData())
      .catch((err) => message.error(`目标保存失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  /* ===== 导出 Markdown / OCR（复用 NotesPage 能力） ===== */
  const exportMarkdown = (): void => {
    const blob = new Blob([noteDraft], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `笔记-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
    message.success('已导出 Markdown')
  }

  const ocrImage = async (file: File): Promise<void> => {
    setOcrBusy(true)
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('图片读取失败'))
        reader.readAsDataURL(file)
      })
      const result = await window.api.ai.ocr({ image: dataUrl })
      if (!result.ok) {
        message.error(result.error ?? '识别失败')
        return
      }
      const block = `\n\n> 🖼️ ${file.name}（OCR ${new Date().toLocaleString()}）\n\n${result.text}\n`
      setNoteDraft((d) => (d.trim() ? d + block : block))
      setNoteDirty(true)
      message.success('识别完成，已插入编辑区（自动保存中）')
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'OCR 失败')
    } finally {
      setOcrBusy(false)
    }
  }

  // 抽屉打开期间：剪贴板粘贴图片直接 OCR（复用 NotesPage 能力）
  useEffect(() => {
    if (!open) return
    const onPaste = (e: ClipboardEvent): void => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file && !ocrBusy) {
        e.preventDefault()
        void ocrImage(file)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ocrBusy])

  const hasBvid = Boolean(context?.bvid)

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width={420}
      title={
        <span>
          <RobotOutlined /> 学习助手
        </span>
      }
      mask={false}
      className="assistant-drawer"
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
    >
      {/* 三页签（与悬浮面板一致） */}
      <div className="overlay-tabs" role="tablist" aria-label="学习助手功能页">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          className={`overlay-tab${tab === 'chat' ? ' active' : ''}`}
          onClick={() => setTab('chat')}
        >
          对话
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'notes'}
          className={`overlay-tab${tab === 'notes' ? ' active' : ''}`}
          onClick={() => setTab('notes')}
        >
          笔记{noteDirty ? ' ●' : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'progress'}
          className={`overlay-tab${tab === 'progress' ? ' active' : ''}`}
          onClick={() => setTab('progress')}
        >
          进度
        </button>
      </div>

      <div className="overlay-body">
        {tab === 'chat' && (
          <ChatPane
            log={aiLog}
            input={aiInput}
            asking={asking}
            logRef={logRef}
            noVideoContext={!hasBvid}
            onInput={setAiInput}
            onSend={() => void askAi()}
            onSaveToNotes={saveReplyToNotes}
          />
        )}
        {tab === 'notes' && (
          <NotesPane
            notes={notes}
            draft={noteDraft}
            editingId={editingNoteId}
            context={context}
            onDraftChange={(v) => {
              setNoteDraft(v)
              setNoteDirty(true)
            }}
            onNewNote={handleNewNote}
            onSelectNote={handleSelectNote}
            onDeleteNote={handleDeleteNote}
            onToggleKey={handleToggleKey}
            onMarkKeyPoint={() => {
              /* 非视频模式无播放器位置可记录（按钮已禁用） */
            }}
            onSeek={handleSeek}
            onExport={exportMarkdown}
            onOcr={() => fileRef.current?.click()}
            ocrBusy={ocrBusy}
          />
        )}
        {tab === 'progress' && (
          <ProgressPane
            current={progress}
            all={allProgress}
            bvid={context?.bvid}
            onMarkDone={handleMarkDone}
            onSetGoal={handleSetGoal}
            onSeek={handleSeek}
            onRefresh={() => void loadData()}
          />
        )}
      </div>

      {/* 隐藏的文件选择（图片 OCR） */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void ocrImage(file)
          e.target.value = ''
        }}
      />
    </Drawer>
  )
}

export default LearningAssistantDrawer
