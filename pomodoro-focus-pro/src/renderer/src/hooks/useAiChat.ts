import { useCallback, useRef, useState } from 'react'
import type { AiMessage, BiliContext } from '../../../shared/bili'
import type { AiStreamChunk } from '../../../shared/ai'
import type { ScrollAreaHandle } from '../components/ScrollArea'
import type { ChatMsg } from '../overlay/ChatPane'
import { extractErrorMessage } from '../utils/errorMessage'

/**
 * 共享 AI 流式问答 hook（H-07/H-09/H-11 统一）。
 *
 * 视频学习助手的两处入口——悬浮面板（OverlayApp）与学习助手抽屉
 * （LearningAssistantDrawer）——过去各自实现一遍"ai:bili-ask + ai:chunk 流式问答"
 * （requestId 关联、最近 8 轮历史、错误处理）。本 hook 抽出这份逻辑，两处共用。
 *
 * @param requestIdPrefix 请求关联 ID 前缀（如 'bili' / 'drawer'），仅用于可读性
 * @param getContext 读取当前学习上下文（须稳定引用，建议读自 ref）
 * @param fallbackTopic 非视频模式下基于学习主题作答时提供主题；视频模式不传
 */
export interface UseAiChatOptions {
  requestIdPrefix: string
  getContext: () => BiliContext | null
  fallbackTopic?: () => string | undefined
}

export function useAiChat({ requestIdPrefix, getContext, fallbackTopic }: UseAiChatOptions): {
  aiLog: ChatMsg[]
  aiInput: string
  asking: boolean
  setAiInput: (v: string) => void
  setWelcome: (message: string) => void
  askAi: () => Promise<void>
  continueAi: (messageId: string) => Promise<void>
  logRef: React.RefObject<ScrollAreaHandle>
} {
  const [aiLog, setAiLog] = useState<ChatMsg[]>([])
  const [aiInput, setAiInput] = useState('')
  const [asking, setAsking] = useState(false)
  const logRef = useRef<ScrollAreaHandle>(null)
  // 最新状态镜像：供 useCallback 的异步闭包读取最新值（闭包里的 aiLog 已过期）
  const ref = useRef({ aiLog, aiInput, asking })
  ref.current = { aiLog, aiInput, asking }

  /** 设置欢迎语（系统消息，不带"记入笔记"按钮） */
  const setWelcome = useCallback((message: string): void => {
    setAiLog([{ id: 'welcome', role: 'assistant', content: message, welcome: true }])
  }, [])

  /** 发送提问：流式渲染（ai:bili-ask + ai:chunk 按 requestId 关联） */
  const askAi = useCallback(async (): Promise<void> => {
    const cur = ref.current
    const text = cur.aiInput.trim()
    if (!text || cur.asking) return
    const ctx = getContext()
    const topic = ctx?.topic ?? fallbackTopic?.()
    const requestId = `${requestIdPrefix}-${Date.now()}`

    // 携带最近 8 轮对话（不含本轮提问），主进程注入 messages 保持多轮连贯
    const history: AiMessage[] = cur.aiLog
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          m.content.trim() &&
          !m.streaming &&
          !m.incomplete
      )
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }))

    setAiLog((prev) => [
      ...prev,
      { id: `u-${requestId}`, role: 'user', content: text },
      { id: requestId, role: 'assistant', content: '', streaming: true, prompt: text }
    ])
    setAiInput('')
    setAsking(true)

    const off = window.api.on<AiStreamChunk>(window.api.events.ai.chunk, (chunk) => {
      if (chunk.requestId !== requestId) return
      if (!chunk.done) {
        setAiLog((prev) =>
          prev.map((m) =>
            m.id === requestId && m.streaming ? { ...m, content: m.content + chunk.delta } : m
          )
        )
      } else if (chunk.incomplete) {
        setAiLog((prev) =>
          prev.map((m) =>
            m.id === requestId
              ? { ...m, streaming: false, incomplete: true, error: chunk.error }
              : m
          )
        )
        off()
      } else if (chunk.aborted) {
        setAiLog((prev) =>
          prev.map((m) => (m.id === requestId ? { ...m, streaming: false } : m))
        )
        off()
      } else if (chunk.content) {
        const content = chunk.content
        setAiLog((prev) =>
          prev.map((m) =>
            m.id === requestId ? { ...m, role: 'assistant', content, streaming: false, incomplete: false, error: undefined } : m
          )
        )
        off()
      }
    })

    try {
      const reply = await window.api.ai.biliAsk({
        requestId,
        message: text,
        context: {
          topic: topic ?? undefined,
          resourceKind: ctx?.resourceKind,
          bvid: ctx?.resourceKind === 'local' || ctx?.resourceKind === 'web' ? undefined : ctx?.bvid,
          videoTitle: ctx?.videoTitle ?? undefined
        },
        history
      })
      setAiLog((prev) =>
        prev.map((m) =>
          m.id === requestId ? { id: m.id, role: 'assistant', content: reply.content } : m
        )
      )
    } catch (err) {
      const friendly = extractErrorMessage(err)
      setAiLog((prev) =>
        prev.map((m) => {
          if (m.id !== requestId) return m
          const keep = m.content.trim().length > 0
          return {
            ...m,
            streaming: false,
            incomplete: keep,
            error: friendly,
            content: keep ? m.content : `AI 调用失败：${friendly}`
          }
        })
      )
    } finally {
      off()
      setAsking(false)
    }
  }, [requestIdPrefix, getContext, fallbackTopic])

  const continueAi = useCallback(async (messageId: string): Promise<void> => {
    const cur = ref.current
    if (cur.asking) return
    const idx = cur.aiLog.findIndex((m) => m.id === messageId)
    const target = cur.aiLog[idx]
    if (!target?.incomplete || !target.prompt) return
    const userIdx = cur.aiLog[idx - 1]?.role === 'user' ? idx - 1 : -1
    const history: AiMessage[] = cur.aiLog
      .slice(0, userIdx >= 0 ? userIdx : idx)
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          m.content.trim() &&
          !m.streaming &&
          !m.incomplete
      )
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }))
    const ctx = getContext()
    const topic = ctx?.topic ?? fallbackTopic?.()
    setAiLog((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, streaming: true, incomplete: false, error: undefined } : m
      )
    )
    setAsking(true)
    const off = window.api.on<AiStreamChunk>(window.api.events.ai.chunk, (chunk) => {
      if (chunk.requestId !== messageId) return
      if (!chunk.done) {
        setAiLog((prev) =>
          prev.map((m) =>
            m.id === messageId && m.streaming ? { ...m, content: m.content + chunk.delta } : m
          )
        )
      }
    })
    try {
      const reply = await window.api.ai.biliAsk({
        requestId: messageId,
        message: target.prompt,
        continueFrom: target.content,
        context: {
          topic: topic ?? undefined,
          resourceKind: ctx?.resourceKind,
          bvid: ctx?.resourceKind === 'local' || ctx?.resourceKind === 'web' ? undefined : ctx?.bvid,
          videoTitle: ctx?.videoTitle ?? undefined
        },
        history
      })
      setAiLog((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, content: reply.content || m.content, streaming: false, incomplete: false, error: undefined }
            : m
        )
      )
    } catch (err) {
      const friendly = extractErrorMessage(err)
      setAiLog((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, streaming: false, incomplete: true, error: friendly } : m
        )
      )
    } finally {
      off()
      setAsking(false)
    }
  }, [getContext, fallbackTopic])

  return { aiLog, aiInput, asking, setAiInput, setWelcome, askAi, continueAi, logRef }
}
