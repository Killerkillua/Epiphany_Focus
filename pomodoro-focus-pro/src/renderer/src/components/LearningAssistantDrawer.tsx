import { useCallback, useEffect, useRef, useState } from 'react'
import { Drawer, message } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import type { BiliContext } from '../../../shared/bili'
import ChatPane from '../overlay/ChatPane'
import NotesPane from '../overlay/NotesPane'
import ProgressPane from '../overlay/ProgressPane'
import { useAiChat } from '../hooks/useAiChat'
import { useNotes } from '../hooks/useNotes'

type AssistantTab = 'chat' | 'notes' | 'progress'

interface LearningAssistantDrawerProps {
  open: boolean
  /** 当前学习主题（搜索关键词），供非视频模式 AI 上下文使用 */
  topic?: string
  onClose(): void
}

/**
 * 学习助手抽屉（问题 3）：视频学习页顶部导航栏右侧入口。
 * - 非视频模式可用：对话（基于学习主题）/ 笔记（增删改 + 导出 + OCR）/ 进度三页签
 * - 复用 overlay 的 ChatPane / NotesPane / ProgressPane，与视频模式共享 SQLite 数据
 * - H-07：AI 问答与笔记逻辑复用共享 hook useAiChat / useNotes（与悬浮面板 OverlayApp 消除重复）
 * - 打开视频时由 BiliModePage 自动关闭（与悬浮面板互斥）
 */
function LearningAssistantDrawer({
  open,
  topic,
  onClose
}: LearningAssistantDrawerProps): JSX.Element {
  const [tab, setTab] = useState<AssistantTab>('chat')
  const [context, setContext] = useState<BiliContext | null>(null)

  // 上下文 ref：供共享 hook 的稳定 getContext 读取最新值
  const contextRef = useRef<BiliContext | null>(context)
  contextRef.current = context
  const getContext = useCallback(() => contextRef.current, [])
  // 非视频模式的学习主题降级（hook 内用 ref 读取最新值）
  const topicRef = useRef(topic)
  topicRef.current = topic
  const getFallbackTopic = useCallback(() => topicRef.current, [])

  // H-07：AI 问答与笔记逻辑复用共享 hook（抽屉 source='main'）
  const { aiLog, aiInput, asking, setAiInput, setWelcome, askAi, logRef } = useAiChat({
    requestIdPrefix: 'drawer',
    getContext,
    fallbackTopic: getFallbackTopic
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
    saveReplyToNotes
  } = useNotes({ source: 'main', getContext })

  // OCR
  const [ocrBusy, setOcrBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /* ===== 打开抽屉：加载共享数据（notes / 上下文；进度走 progressStore） ===== */
  const loadData = useCallback(async (): Promise<void> => {
    try {
      const ctx = await window.api.bili.getContext()
      setContext(ctx)
      // 打开视频时按视频归档加载；非视频模式加载全部笔记（与视频模式共享 SQLite notes 表）
      await loadNotes(ctx?.bvid)
      // 欢迎语：非视频模式基于学习主题作答
      const lines = ['已打开学习助手。']
      const t = ctx?.topic ?? topic
      if (t) lines.push(`学习主题「${t}」，随时可以提问、记笔记、查进度。`)
      else lines.push('输入学习主题后可基于主题提问；打开视频后自动切换为视频上下文。')
      setWelcome(lines.join('\n'))
    } catch (err) {
      console.error('[assistant-drawer] 数据加载失败:', err)
    }
  }, [topic, loadNotes, setWelcome])

  useEffect(() => {
    if (open) void loadData()
  }, [open, loadData])

  /** F-2 时间点跳转：视频模式有效；非视频模式提示先打开视频 */
  const handleSeek = (seconds: number): void => {
    if (!context?.bvid) {
      message.info('需先打开对应视频才能跳转到时间点')
      return
    }
    void window.api.bili
      .seekTo({ bvid: context.bvid, seconds })
      .catch((err) =>
        message.error(`跳转失败: ${err instanceof Error ? err.message : String(err)}`)
      )
  }

  /* ===== 导出 Markdown / OCR（复用 NotesPage 能力） ===== */
  const exportMarkdown = (): void => {
    const blob = new Blob([noteDraft], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `笔记-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    // 推迟到下载触发后再释放：a.click() 的下载由浏览器异步接管，
    // 同步栈内 revokeObjectURL 可能导致部分浏览器取消下载
    setTimeout(() => URL.revokeObjectURL(url), 1000)
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
      setDraft((d) => (d.trim() ? d + block : block))
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
            onDraftChange={setDraft}
            onNewNote={newNote}
            onSelectNote={selectNote}
            onDeleteNote={deleteNote}
            onToggleKey={toggleKey}
            onMarkKeyPoint={() => {
              /* 非视频模式无播放器位置可记录（按钮已禁用） */
            }}
            onSeek={handleSeek}
            onExport={exportMarkdown}
            onOcr={() => fileRef.current?.click()}
            ocrBusy={ocrBusy}
          />
        )}
        {tab === 'progress' && <ProgressPane bvid={context?.bvid} onSeek={handleSeek} />}
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
