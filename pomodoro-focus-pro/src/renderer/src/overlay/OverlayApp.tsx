import { useEffect, useRef, useState } from 'react'
import { Button, Input, Tooltip } from 'antd'
import {
  CloseOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  SendOutlined,
  EditOutlined
} from '@ant-design/icons'
import { OVERLAY_COLLAPSED_SIZE, OVERLAY_EXPANDED_SIZE } from '../../../shared/bili'
import type { AiMessage, BiliContext, NoteEntry } from '../../../shared/bili'

/**
 * 全屏悬浮面板（#overlay 路由，透明置顶窗口内运行）：
 * - AI 学习助手（占位接口，经 ai:ask 调用 src/main/ai 网关桩）
 * - 记事本（500ms 防抖自动保存）
 * - 整体可折叠为侧边竖条（经 bili:overlay-set-size 调整窗口尺寸）
 */

function OverlayApp(): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [context, setContext] = useState<BiliContext | null>(null)
  const [notes, setNotes] = useState('')
  const [aiInput, setAiInput] = useState('')
  const [aiLog, setAiLog] = useState<AiMessage[]>([])
  const [asking, setAsking] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // 初始化：取学习上下文 + 载入已存笔记
  useEffect(() => {
    void window.api.bili.getContext().then((ctx) => {
      setContext(ctx)
      setAiLog([
        {
          role: 'assistant',
          content:
            `已进入 B 站学习模式${ctx?.topic ? `，主题「${ctx.topic}」` : ''}。\n` +
            'AI 网关为占位接口（src/main/ai），接入模型后即可在这里提问。'
        }
      ])
    })
    void window.api.notes.load().then((entries: NoteEntry[]) => {
      setNotes(entries.map((entry) => entry.content).join('\n\n'))
    })
  }, [])

  // 记事本：500ms 防抖自动保存（整份覆盖）
  useEffect(() => {
    if (!notes) return
    const timer = setTimeout(() => {
      void window.api.notes.save([{ id: 'main', createdAt: Date.now(), content: notes }]).catch((err) => {
        console.error('[overlay] 笔记保存失败:', err)
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [notes])

  // AI 对话自动滚动到底部
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [aiLog])

  const toggleCollapsed = (): void => {
    const next = !collapsed
    setCollapsed(next)
    void window.api.bili
      .overlaySetSize(next ? OVERLAY_COLLAPSED_SIZE : OVERLAY_EXPANDED_SIZE)
      .catch((err) => console.error('[overlay] 调整尺寸失败:', err))
  }

  const askAi = async (): Promise<void> => {
    const text = aiInput.trim()
    if (!text || asking) return
    setAiInput('')
    setAiLog((log) => [...log, { role: 'user', content: text }])
    setAsking(true)
    try {
      const reply = await window.api.ai.ask({
        message: text,
        context: { topic: context?.topic ?? undefined }
      })
      setAiLog((log) => [...log, reply])
    } catch (err) {
      setAiLog((log) => [
        ...log,
        {
          role: 'assistant',
          content: `AI 调用失败：${err instanceof Error ? err.message : String(err)}`
        }
      ])
    } finally {
      setAsking(false)
    }
  }

  const closeVideo = (): void => {
    void window.api.bili.closeVideo().catch((err) => console.error('[overlay] 关闭视频窗口失败:', err))
  }

  /* ===== 折叠态：侧边竖条 ===== */
  if (collapsed) {
    return (
      <div className="overlay-tab">
        <Tooltip title="展开面板" placement="right">
          <Button
            type="text"
            className="overlay-tab-btn"
            icon={<MenuUnfoldOutlined />}
            onClick={toggleCollapsed}
          />
        </Tooltip>
        <div className="overlay-tab-label">学习助手</div>
        <Tooltip title="关闭视频" placement="right">
          <Button type="text" className="overlay-tab-btn" icon={<CloseOutlined />} onClick={closeVideo} />
        </Tooltip>
      </div>
    )
  }

  /* ===== 展开态：AI 助手 + 记事本 ===== */
  return (
    <div className="overlay-root">
      <div className="overlay-header">
        <span className="overlay-title">
          <RobotOutlined /> 学习助手
          {context?.bvid && <span className="overlay-bvid">{context.bvid}</span>}
        </span>
        <div className="overlay-header-actions">
          <Tooltip title="折叠面板">
            <Button type="text" size="small" icon={<MenuFoldOutlined />} onClick={toggleCollapsed} />
          </Tooltip>
          <Tooltip title="关闭视频">
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={closeVideo} />
          </Tooltip>
        </div>
      </div>

      <div className="overlay-body">
        {/* AI 助手 */}
        <div className="overlay-section overlay-ai">
          <div className="overlay-section-title">AI 助手（占位）</div>
          <div className="overlay-ai-log" ref={logRef}>
            {aiLog.map((msg, index) => (
              <div key={index} className={`overlay-msg ${msg.role === 'user' ? 'user' : 'assistant'}`}>
                {msg.content}
              </div>
            ))}
            {asking && <div className="overlay-msg assistant overlay-typing">思考中…</div>}
          </div>
          <div className="overlay-ai-input">
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 3 }}
              placeholder="向 AI 提问（网关占位）"
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void askAi()
                }
              }}
            />
            <Button
              type="primary"
              size="small"
              icon={<SendOutlined />}
              loading={asking}
              disabled={!aiInput.trim()}
              onClick={() => void askAi()}
            />
          </div>
        </div>

        {/* 记事本 */}
        <div className="overlay-section overlay-notes">
          <div className="overlay-section-title">
            <EditOutlined /> 记事本 <span className="overlay-autosave">500ms 自动保存</span>
          </div>
          <Input.TextArea
            className="overlay-notes-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="随时记录要点 / 疑问 / 灵感…"
          />
        </div>
      </div>
    </div>
  )
}

export default OverlayApp
