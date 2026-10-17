import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  Collapse,
  Dropdown,
  Empty,
  Input,
  List,
  Segmented,
  Space,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  DeleteOutlined,
  BookOutlined,
  BulbOutlined,
  DownloadOutlined,
  FileImageOutlined
} from '@ant-design/icons'
import MarkdownView from '../components/MarkdownView'
import ScrollArea, { type ScrollAreaHandle } from '../components/ScrollArea'
import SourcesPanel from '../components/SourcesPanel'
import SessionTimerBar from '../components/SessionTimerBar'
import { useEnglishStore, type ChatMessage } from '../store/englishStore'
import { extractErrorMessage } from '../utils/errorMessage'
import type { AiScenario } from '../../../shared/ai'
import type { VocabExportFormat } from '../../../shared/export'

const { TextArea } = Input

const SCENARIOS: Array<{ value: AiScenario; label: string }> = [
  { value: 'grammar', label: '语法讲解' },
  { value: 'vocabulary', label: '词汇查询' },
  { value: 'conversation', label: '对话练习' },
  { value: 'writing', label: '写作批改' },
  { value: 'free', label: '自由提问' }
]

const SCENARIO_PLACEHOLDER: Record<AiScenario, string> = {
  grammar: '如：I suggest him to go 对吗？',
  vocabulary: '输入要查询的单词，如 serendipity',
  conversation: '输入话题，如：和我聊聊天气',
  writing: '粘贴要批改的英文段落',
  free: '自由提问英语学习问题…'
}

/** 与主进程 vocab.word 校验一致 */
const VOCAB_WORD_MAX = 200

interface VocabPick {
  text: string
  top: number
  left: number
}

/** 选区两端都落在同一条对话气泡的正文里（不含操作按钮） */
function bubbleOf(node: Node | null): Element | null {
  const el = node instanceof Element ? node : node?.parentElement
  if (!el || el.closest('.chat-msg-actions')) return null
  return el.closest('.chat-msg-bubble')
}

function readChatSelection(viewport: HTMLElement): VocabPick | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const text = sel.toString().replace(/\s+/g, ' ').trim()
  if (!text) return null
  const start = bubbleOf(sel.anchorNode)
  const end = bubbleOf(sel.focusNode)
  if (!start || start !== end || !viewport.contains(start)) return null
  const range = sel.getRangeAt(0)
  const rects = range.getClientRects()
  const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return {
    text,
    top: Math.max(8, rect.top - 8),
    left: Math.min(Math.max(8, rect.left), window.innerWidth - 132)
  }
}

/** 去除 Markdown 符号的纯文本 */
function stripMarkdown(text: string): string {
  return text
    .replace(/[*_#`>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

function MessageItem({ msg }: { msg: ChatMessage }): JSX.Element {
  const { addGrammar, continue: continueReply } = useEnglishStore()
  const [busy, setBusy] = useState(false)

  const isUser = msg.role === 'user'

  const handleAddGrammar = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const plain = stripMarkdown(msg.content)
      const title = plain.split(/[\n。]/)[0].slice(0, 30) || '语法要点'
      await addGrammar({ title, summary: plain.slice(0, 320) })
      message.success('已加入语法要点')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`chat-msg ${isUser ? 'user' : 'assistant'}`}>
      <div className="chat-msg-bubble">
        {isUser ? (
          <div className="chat-user-text">{msg.content}</div>
        ) : (
          <>
            {msg.content ? (
              <MarkdownView content={msg.content} />
            ) : (
              <span className="chat-thinking">思考中…</span>
            )}
            {msg.streaming && <span className="chat-cursor" />}
            {msg.incomplete && !msg.streaming && (
              <div className="chat-msg-actions">
                <Button size="small" type="link" onClick={() => void continueReply(msg.id).catch((err) => message.error(extractErrorMessage(err)))}>
                  继续生成
                </Button>
                {msg.error && (
                  <span className="chat-thinking">{msg.error}</span>
                )}
              </div>
            )}
            <SourcesPanel sources={msg.sources} />
            {!msg.streaming && msg.content && (
              <div className="chat-msg-actions">
                <Tooltip title="将该回复要点加入语法要点">
                  <Button
                    size="small"
                    type="text"
                    icon={<BulbOutlined />}
                    onClick={() => void handleAddGrammar()}
                  >
                    语法要点
                  </Button>
                </Tooltip>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function EnglishModePage(): JSX.Element {
  const {
    messages,
    isStreaming,
    config,
    usage,
    vocab,
    grammar,
    init,
    ask,
    refreshLists,
    addVocab,
    deleteVocab,
    deleteGrammar
  } = useEnglishStore()

  const [scenario, setScenario] = useState<AiScenario>('grammar')
  const [input, setInput] = useState('')
  const [ocrBusy, setOcrBusy] = useState(false)
  const [vocabPick, setVocabPick] = useState<VocabPick | null>(null)
  const listRef = useRef<ScrollAreaHandle>(null)
  const ocrFileRef = useRef<HTMLInputElement>(null)
  const vocabPopRef = useRef<HTMLDivElement>(null)
  /** 点浮层时选区会先塌掉，这段时间不要把浮层关掉，否则 click 到不了按钮 */
  const vocabPopHold = useRef(false)

  useEffect(() => {
    void init()
  }, [init])

  // 新消息自动滚到底部，并收起选词浮层（滚动后位置已失效）
  useEffect(() => {
    const el = listRef.current?.viewport
    if (el) el.scrollTop = el.scrollHeight
    setVocabPick(null)
  }, [messages])

  useEffect(() => {
    const viewport = listRef.current?.viewport
    if (!viewport) return

    const onMouseUp = (event: MouseEvent): void => {
      if (vocabPopRef.current?.contains(event.target as Node)) return
      window.setTimeout(() => {
        const host = listRef.current?.viewport
        setVocabPick(host ? readChatSelection(host) : null)
      }, 0)
    }
    const onMouseDown = (event: MouseEvent): void => {
      if (vocabPopRef.current?.contains(event.target as Node)) return
      setVocabPick(null)
    }
    const onScroll = (): void => setVocabPick(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setVocabPick(null)
    }
    const onSelectionChange = (): void => {
      if (vocabPopHold.current) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setVocabPick(null)
    }

    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('selectionchange', onSelectionChange)
    viewport.addEventListener('scroll', onScroll)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('selectionchange', onSelectionChange)
      viewport.removeEventListener('scroll', onScroll)
    }
  }, [])

  const addSelectedVocab = async (text: string): Promise<void> => {
    const word = text.replace(/\s+/g, ' ').trim()
    setVocabPick(null)
    window.getSelection()?.removeAllRanges()
    if (!word) return
    if (word.length > VOCAB_WORD_MAX) {
      message.warning(`选中内容超过 ${VOCAB_WORD_MAX} 字，请缩短后再加入`)
      return
    }
    try {
      const existed = await addVocab({ word })
      message.success(
        existed ? '已在生词本，可在记事本查看' : `已加入生词本：${word}，可在记事本查看`
      )
    } catch (err) {
      message.error(extractErrorMessage(err))
    }
  }

  const exportVocab = async (format: VocabExportFormat): Promise<void> => {
    try {
      const res = await window.api.export.vocab({ format })
      if (res.canceled) return
      if (res.ok) message.success(format === 'apkg' ? '已导出 Anki 卡包' : '已导出 Anki 文本')
      else message.error(res.error ?? '导出失败')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '导出失败')
    }
  }

  const handleSend = async (): Promise<void> => {
    const text = input.trim()
    if (!text || isStreaming) return
    // 发送瞬间立即清空输入框，避免流式响应期间残留已发送文本
    setInput('')
    const word = scenario === 'vocabulary' ? text : undefined
    try {
      await ask(scenario, text, word)
    } catch (err) {
      message.error(extractErrorMessage(err))
    }
  }

  /** 选择图片 → OCR 识别文字 → 填入输入框（作为问题发送） */
  const handleOcrImage = async (file: File): Promise<void> => {
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
      const text = result.text.trim()
      if (!text) {
        message.warning('未识别到文字')
        return
      }
      setInput(text.length > 4000 ? text.slice(0, 4000) : text)
      message.success('识别完成，文字已填入输入框')
    } catch (err) {
      message.error(extractErrorMessage(err))
    } finally {
      setOcrBusy(false)
    }
  }

  const remaining = usage.limit - usage.used

  return (
    <div>
      <h1 className="page-title">英语学习模式</h1>
      <p className="page-sub">
        AI 母语者陪练 · 分层 Prompt · RAG 权威词典增强
        {config.apiKey
          ? ` · 模型 ${config.model}`
          : ' · 演示模式（未配置 API Key，请到 设置 → AI 设置 配置后生效）'}
      </p>

      {/* 学习会话计时（倒计时 + 进度 + 学习时长统计） */}
      <SessionTimerBar mode="english" />

      <div className="english-layout">
        {/* ===== 对话区 ===== */}
        <div className="english-chat">
          <ScrollArea className="chat-list" ref={listRef}>
            {messages.length === 0 ? (
              <Empty
                style={{ marginTop: 80 }}
                description="选择场景开始提问，AI 将以英语母语者水平讲解"
              />
            ) : (
              messages.map((m) => <MessageItem key={m.id} msg={m} />)
            )}
          </ScrollArea>
          {vocabPick &&
            createPortal(
              <div
                ref={vocabPopRef}
                className="vocab-select-pop"
                style={{ top: vocabPick.top, left: vocabPick.left }}
              >
                <Button
                  size="small"
                  type="primary"
                  icon={<BookOutlined />}
                  onMouseDown={(event) => {
                    vocabPopHold.current = true
                    event.preventDefault()
                  }}
                  onMouseUp={() => {
                    window.setTimeout(() => {
                      vocabPopHold.current = false
                    }, 0)
                  }}
                  onClick={() => void addSelectedVocab(vocabPick.text)}
                >
                  加入生词本
                </Button>
              </div>,
              document.body
            )}

          <div className="chat-input-bar">
            <Segmented
              size="small"
              options={SCENARIOS}
              value={scenario}
              onChange={(v) => setScenario(v as AiScenario)}
            />
            <div className="chat-input-row">
              <TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={SCENARIO_PLACEHOLDER[scenario]}
                autoSize={{ minRows: 1, maxRows: 4 }}
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
              />
              <Button
                icon={<FileImageOutlined />}
                disabled={isStreaming || ocrBusy}
                loading={ocrBusy}
                title="识别图片文字并填入输入框（OCR）"
                onClick={() => ocrFileRef.current?.click()}
              />
              <Button
                type="primary"
                disabled={isStreaming || !input.trim()}
                loading={isStreaming}
                onClick={() => void handleSend()}
              >
                发送
              </Button>
            </div>
            <div className="chat-usage">
              本会话提问 {usage.used}/{usage.limit} · 剩余 {remaining}
              {!config.apiKey && (
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  AI 配置请到「设置 → AI 设置」
                </Typography.Text>
              )}
            </div>
          </div>
        </div>

        {/* 隐藏的文件选择（OCR） */}
        <input
          ref={ocrFileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleOcrImage(file)
            e.target.value = ''
          }}
        />

        {/* ===== 侧栏：生词本 + 语法要点 ===== */}
        <ScrollArea className="english-side">
          <Card
            size="small"
            title="📖 生词本"
            className="english-side-card"
            extra={
              <Space size={4}>
                <Tooltip
                  title={vocab.length === 0 ? '生词本是空的，先加入单词再导出' : '导出到 Anki'}
                >
                  <span>
                    <Dropdown
                      disabled={vocab.length === 0}
                      menu={{
                        items: [
                          { key: 'apkg', label: 'Anki 卡包 (.apkg)' },
                          { key: 'txt', label: 'Anki 文本 (.txt)' }
                        ],
                        onClick: ({ key }) => void exportVocab(key === 'txt' ? 'txt' : 'apkg')
                      }}
                    >
                      <Button
                        size="small"
                        type="text"
                        icon={<DownloadOutlined />}
                        disabled={vocab.length === 0}
                      />
                    </Dropdown>
                  </span>
                </Tooltip>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {vocab.length}
                </Typography.Text>
              </Space>
            }
          >
            <Typography.Text type="secondary" className="vocab-side-hint">
              完整列表请到记事本查看
            </Typography.Text>
            <ScrollArea style={{ maxHeight: 216 }}>
              {vocab.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  选中对话中的单词或短语即可加入。完整列表请到记事本查看
                </Typography.Text>
              ) : (
                <List
                  size="small"
                  dataSource={vocab}
                  renderItem={(v) => (
                    <List.Item
                      actions={[
                        <DeleteOutlined
                          key="del"
                          style={{ color: 'var(--muted)' }}
                          onClick={() => void deleteVocab(v.id)}
                        />
                      ]}
                    >
                      <span>{v.word}</span>
                    </List.Item>
                  )}
                />
              )}
            </ScrollArea>
          </Card>

          <Card
            size="small"
            title="🧠 语法要点"
            className="english-side-card"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {grammar.length}
              </Typography.Text>
            }
          >
            <ScrollArea style={{ maxHeight: 216 }}>
              {grammar.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  回复下点击"语法要点"收藏讲解
                </Typography.Text>
              ) : (
                <Collapse
                  size="small"
                  ghost
                  items={grammar.map((g) => ({
                    key: String(g.id),
                    label: (
                      <Space size={4}>
                        <span>{g.title}</span>
                        <DeleteOutlined
                          style={{ color: 'var(--muted)', fontSize: 12 }}
                          onClick={(e) => {
                            e.stopPropagation()
                            void deleteGrammar(g.id)
                          }}
                        />
                      </Space>
                    ),
                    children: <div className="grammar-summary">{g.summary}</div>
                  }))}
                />
              )}
            </ScrollArea>
          </Card>

          <Typography.Text type="secondary" style={{ fontSize: 11, lineHeight: 1.6 }}>
            提示：语法/写作讲解使用 Chain-of-Thought 逐步推理；词汇查询自动触发 RAG 检索
            Merriam-Webster / Cambridge / Oxford 权威词典并标注来源。
          </Typography.Text>
        </ScrollArea>
      </div>
    </div>
  )
}

export default EnglishModePage
