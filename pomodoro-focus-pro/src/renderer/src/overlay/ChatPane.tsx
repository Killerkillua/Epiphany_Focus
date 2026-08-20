import { Button, Input } from 'antd'
import { SaveOutlined, SendOutlined } from '@ant-design/icons'
import type { RefObject } from 'react'
import ScrollArea, { type ScrollAreaHandle } from '../components/ScrollArea'
import MarkdownView from '../components/MarkdownView'

/** 对话消息（流式进行中 streaming=true，底部渲染"记入笔记"需等流结束） */
export interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  /** 欢迎语等系统消息：不显示"记入笔记"按钮 */
  welcome?: boolean
}

interface ChatPaneProps {
  log: ChatMsg[]
  input: string
  asking: boolean
  logRef: RefObject<ScrollAreaHandle>
  onInput(value: string): void
  onSend(): void
  /** I-4 问答↔笔记联动：把 AI 回答一键沉淀为笔记 */
  onSaveToNotes(msg: ChatMsg): void
  /** 非视频模式（学习助手抽屉）：无视频上下文时的空态提示 */
  noVideoContext?: boolean
}

/**
 * 对话页签（I-1）：AI 助手全高空间，长回答不再被笔记挤压；
 * 流式渲染（F-4/P-2）逐字出现；回答底部提供「记入笔记」快捷落库。
 */
function ChatPane({
  log,
  input,
  asking,
  logRef,
  onInput,
  onSend,
  onSaveToNotes,
  noVideoContext = false
}: ChatPaneProps): JSX.Element {
  return (
    <div className="overlay-pane overlay-chat-pane">
      <ScrollArea className="overlay-ai-log" ref={logRef}>
        {log.map((msg) => (
          <div key={msg.id} className={`overlay-msg ${msg.role === 'user' ? 'user' : 'assistant'}`}>
            {msg.role === 'assistant' ? (
              <MarkdownView content={msg.content} />
            ) : (
              <div className="overlay-msg-plain">{msg.content}</div>
            )}
            {msg.role === 'assistant' && !msg.streaming && !msg.welcome && (
              <div className="overlay-msg-actions">
                <Button
                  type="text"
                  size="small"
                  icon={<SaveOutlined />}
                  className="overlay-save-note-btn"
                  onClick={() => onSaveToNotes(msg)}
                >
                  记入笔记
                </Button>
              </div>
            )}
          </div>
        ))}
        {asking && <div className="overlay-msg assistant overlay-typing">思考中…</div>}
      </ScrollArea>
      {noVideoContext && (
        <div className="overlay-ai-hint">
          📌 当前未打开视频，可基于学习主题提问；打开视频后自动切换为视频上下文。
        </div>
      )}
      <div className="overlay-ai-input">
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 3 }}
          placeholder="向 AI 提问，如：讲解这个概念 / 总结要点 / 出几道测验题"
          value={input}
          onChange={(e) => onInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
        />
        <Button
          type="primary"
          size="small"
          icon={<SendOutlined />}
          loading={asking}
          disabled={!input.trim()}
          onClick={onSend}
        />
      </div>
    </div>
  )
}

export default ChatPane
