import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  List,
  Segmented,
  Space,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  DeleteOutlined,
  BookOutlined,
  BulbOutlined,
  FileImageOutlined
} from '@ant-design/icons'
import MarkdownView from '../components/MarkdownView'
import SourcesPanel from '../components/SourcesPanel'
import SessionTimerBar from '../components/SessionTimerBar'
import { useEnglishStore, type ChatMessage } from '../store/englishStore'
import type { AiScenario } from '../../../shared/ai'

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

/** 从回复中提取单词（加粗词优先，其次首个 ≥3 字母英文词） */
function extractWordFromContent(content: string): string {
  const bold = content.match(/\*\*([A-Za-z][A-Za-z'-]{2,40})\*\*/)
  if (bold) return bold[1].toLowerCase()
  const plain = content.replace(/[*#`>|]/g, '')
  const m = plain.match(/[A-Za-z][A-Za-z'-]{2,40}/)
  return m ? m[0].toLowerCase() : ''
}

/** 去除 Markdown 符号的纯文本 */
function stripMarkdown(text: string): string {
  return text
    .replace(/[*_#`>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

function MessageItem({ msg }: { msg: ChatMessage }): JSX.Element {
  const { addVocab, addGrammar, config } = useEnglishStore()
  const [busy, setBusy] = useState(false)

  const isUser = msg.role === 'user'

  const handleAddVocab = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const word = msg.queryWord || extractWordFromContent(msg.content)
      if (!word) {
        message.warning('未识别到单词')
        return
      }
      const plain = stripMarkdown(msg.content)
      await addVocab({
        word,
        definition: plain.slice(0, 160) || `${word} 的讲解`
      })
      message.success(`已加入生词本：${word}`)
    } finally {
      setBusy(false)
    }
  }

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
            <SourcesPanel sources={msg.sources} />
            {!msg.streaming && msg.content && (
              <div className="chat-msg-actions">
                <Tooltip title="从该回复提取单词加入生词本">
                  <Button size="small" type="text" icon={<BookOutlined />} onClick={() => void handleAddVocab()}>
                    加入生词本
                  </Button>
                </Tooltip>
                <Tooltip title="将该回复要点加入语法要点">
                  <Button size="small" type="text" icon={<BulbOutlined />} onClick={() => void handleAddGrammar()}>
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
  const { messages, isStreaming, config, usage, vocab, grammar, init, ask, refreshLists, deleteVocab, deleteGrammar } =
    useEnglishStore()

  const [scenario, setScenario] = useState<AiScenario>('grammar')
  const [input, setInput] = useState('')
  const [ocrBusy, setOcrBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const ocrFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void init()
  }, [init])

  // 新消息自动滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const handleSend = async (): Promise<void> => {
    const text = input.trim()
    if (!text || isStreaming) return
    // 发送瞬间立即清空输入框，避免流式响应期间残留已发送文本
    setInput('')
    const word = scenario === 'vocabulary' ? text : undefined
    try {
      await ask(scenario, text, word)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '请求失败')
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
      message.error(err instanceof Error ? err.message : 'OCR 失败')
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
        {config.apiKey ? ` · 模型 ${config.model}` : ' · 演示模式（未配置 API Key，请到 设置 → AI 设置 配置后生效）'}
      </p>

      {/* 学习会话计时（倒计时 + 进度 + 学习时长统计） */}
      <SessionTimerBar mode="english" />

      <div className="english-layout">
        {/* ===== 对话区 ===== */}
        <div className="english-chat">
          <div className="chat-list" ref={listRef}>
            {messages.length === 0 ? (
              <Empty
                style={{ marginTop: 80 }}
                description="选择场景开始提问，AI 将以英语母语者水平讲解"
              />
            ) : (
              messages.map((m) => <MessageItem key={m.id} msg={m} />)
            )}
          </div>

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
        <div className="english-side">
          <Card
            size="small"
            title="📖 生词本"
            className="english-side-card"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {vocab.length}
              </Typography.Text>
            }
          >
            {vocab.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                回复下点击"加入生词本"收藏单词
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
                    <List.Item.Meta
                      title={
                        <Space size={6}>
                          <span>{v.word}</span>
                          {v.phonetic && <Tag style={{ marginInlineEnd: 0 }}>{v.phonetic}</Tag>}
                        </Space>
                      }
                      description={<span className="vocab-def">{v.definition.slice(0, 60)}</span>}
                    />
                  </List.Item>
                )}
              />
            )}
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
          </Card>

          <Typography.Text type="secondary" style={{ fontSize: 11, lineHeight: 1.6 }}>
            提示：语法/写作讲解使用 Chain-of-Thought 逐步推理；词汇查询自动触发 RAG 检索
            Merriam-Webster / Cambridge / Oxford 权威词典并标注来源。
          </Typography.Text>
        </div>
      </div>
    </div>
  )
}

export default EnglishModePage
