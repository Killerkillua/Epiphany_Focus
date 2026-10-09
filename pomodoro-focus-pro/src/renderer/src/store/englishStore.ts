import { create } from 'zustand'
import { extractErrorMessage } from '../utils/errorMessage'
import type {
  AddGrammarPayload,
  AddVocabPayload,
  AiConfig,
  AiQuestion,
  AiScenario,
  AiSource,
  AiStreamChunk,
  AiUsage,
  GrammarPoint,
  VocabEntry
} from '../../../shared/ai'

/**
 * 英语学习模式状态（渲染层）。
 * 流式回复：请求前生成 requestId，经 ai:chunk 事件按 id 过滤增量。
 */

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: AiSource[]
  /** 是否正在流式输出 */
  streaming?: boolean
  /** 流中断，正文是半成品，不能当作完整回复写入下一轮历史 */
  incomplete?: boolean
  /** 中断原因，不覆盖正文 */
  error?: string
  /** 该条关联的提问词（用于一键入本） */
  queryWord?: string
  /** 生成这条回复时的场景，续写时复用 */
  scenario?: AiScenario
}

/**
 * 渲染层 AI 配置初始占位（仅 init() 完成前的类型默认值）。
 * 真实配置（由用户在设置中配置的 API Key）由 init() 从主进程 electron-store 拉取后覆盖，
 * 此处 apiKey 保持空字符串，避免在渲染层 bundle 中明文携带密钥。
 */
const DEFAULT_CONFIG: AiConfig = {
  baseURL: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'Qwen/Qwen3.5-4B',
  maxQuestionsPerSession: 50,
  ocrModel: 'Qwen/Qwen3.5-4B'
}

/** 需要携带多轮上下文的场景（对话练习 / 自由提问） */
const HISTORY_SCENARIOS: AiScenario[] = ['conversation', 'free']

interface EnglishStore {
  messages: ChatMessage[]
  isStreaming: boolean
  config: AiConfig
  usage: AiUsage
  vocab: VocabEntry[]
  grammar: GrammarPoint[]
  init: () => Promise<void>
  /** 取消全部 IPC 事件订阅（HMR 热替换 / 窗口销毁时清理） */
  destroy: () => void
  ask: (scenario: AiScenario, message: string, word?: string) => Promise<void>
  /** 从半成品气泡继续生成，不重复扣提问额度 */
  continue: (messageId: string) => Promise<void>
  refreshConfig: () => Promise<void>
  refreshLists: () => Promise<void>
  addVocab: (payload: AddVocabPayload) => Promise<void>
  deleteVocab: (id: number) => Promise<void>
  addGrammar: (payload: AddGrammarPayload) => Promise<void>
  deleteGrammar: (id: number) => Promise<void>
}

/**
 * CR-07：订阅生命周期管理（同 focusStore / sessionStore）。
 * chunkSubscribed / settingsSubscribed 拆分为两个 globalThis 持久标志防 HMR 重复订阅；
 * 订阅句柄统一收进 unsubscribeFns，destroy() 一次性取消——
 * ai:chunk 为流式高频事件，泄漏会在多次热更新后放大。
 */
const g = globalThis as unknown as {
  __pomodoroEnglishChunkSubscribed?: boolean
  __pomodoroEnglishSettingsSubscribed?: boolean
}
let unsubscribeFns: Array<() => void> = []

function unsubscribeAll(): void {
  for (const fn of unsubscribeFns) fn()
  unsubscribeFns = []
  g.__pomodoroEnglishChunkSubscribed = false
  g.__pomodoroEnglishSettingsSubscribed = false
}

// HMR：模块被热替换前先取消订阅 + 复位标志，新模块实例可干净地重新订阅
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribeAll())
}

export const useEnglishStore = create<EnglishStore>((set, get) => ({
  messages: [],
  isStreaming: false,
  config: DEFAULT_CONFIG,
  usage: { used: 0, limit: 50 },
  vocab: [],
  grammar: [],

  init: async () => {
    if (!g.__pomodoroEnglishChunkSubscribed) {
      g.__pomodoroEnglishChunkSubscribed = true
      unsubscribeFns.push(
        window.api.on<AiStreamChunk>('ai:chunk', (chunk) => {
          if (!chunk.requestId || !get().isStreaming) return
          set((state) => {
            const messages = state.messages.map((m) => {
              if (m.id !== chunk.requestId) return m
              if (chunk.aborted) return { ...m, streaming: false }
              if (chunk.done && chunk.incomplete) {
                return {
                  ...m,
                  content: m.content || chunk.content || '',
                  streaming: false,
                  incomplete: true,
                  error: chunk.error
                }
              }
              if (chunk.done) {
                return {
                  ...m,
                  content: chunk.content ?? m.content,
                  sources: chunk.sources ?? m.sources,
                  streaming: false,
                  incomplete: false,
                  error: undefined
                }
              }
              return { ...m, content: m.content + chunk.delta }
            })
            const isStreaming = chunk.done ? false : messages.some((m) => m.streaming)
            return { messages, isStreaming }
          })
        })
      )
    }
    // 设置变更广播：设置页（或主进程任何 ai 配置写入）保存后实时刷新，无需重进页面
    if (!g.__pomodoroEnglishSettingsSubscribed) {
      g.__pomodoroEnglishSettingsSubscribed = true
      unsubscribeFns.push(
        window.api.on(window.api.events.settings.changed, () => {
          void get().refreshConfig()
        })
      )
    }
    const [config, usage, vocab, grammar] = await Promise.all([
      window.api.ai.getConfig(),
      window.api.ai.usage(),
      window.api.ai.listVocab(),
      window.api.ai.listGrammar()
    ])
    set({ config, usage, vocab, grammar })
  },

  destroy: unsubscribeAll,

  ask: async (scenario, message, word) => {
    const trimmed = message.trim()
    if (!trimmed || get().isStreaming) return

    const requestId = crypto.randomUUID()
    // 需要多轮上下文的场景：从已完成消息取最近 8 轮（过滤 streaming 中的本轮占位）
    const history = HISTORY_SCENARIOS.includes(scenario)
      ? get()
          .messages.filter(
            (m) =>
              !m.streaming &&
              !m.incomplete &&
              (m.role === 'user' || m.role === 'assistant') &&
              m.content.trim()
          )
          .slice(-8)
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      : undefined
    const question: AiQuestion = { requestId, scenario, message: trimmed, word, history }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      sources: []
    }
    const assistantMsg: ChatMessage = {
      id: requestId,
      role: 'assistant',
      content: '',
      sources: [],
      streaming: true,
      queryWord: word ?? trimmed,
      scenario
    }

    set((state) => ({
      messages: [...state.messages, userMsg, assistantMsg],
      isStreaming: true
    }))

    try {
      const reply = await window.api.ai.englishAsk(question)
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === requestId
            ? { ...m, content: reply.content, sources: reply.sources, streaming: false }
            : m
        ),
        isStreaming: false
      }))
      const usage = await window.api.ai.usage()
      set({ usage })
    } catch (err) {
      const friendly = extractErrorMessage(err)
      if (friendly === '已取消') {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === requestId ? { ...m, streaming: false } : m
          ),
          isStreaming: false
        }))
        return
      }
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === requestId
            ? {
                ...m,
                content: m.content || `⚠️ ${friendly}`,
                streaming: false,
                incomplete: m.content.trim().length > 0,
                error: friendly
              }
            : m
        ),
        isStreaming: false
      }))
      throw new Error(friendly)
    }
  },

  continue: async (messageId) => {
    if (get().isStreaming) return
    const messages = get().messages
    const idx = messages.findIndex((m) => m.id === messageId)
    const target = messages[idx]
    if (!target || target.role !== 'assistant' || !target.incomplete) return
    const userIdx = messages[idx - 1]?.role === 'user' ? idx - 1 : -1
    const user = userIdx >= 0 ? messages[userIdx] : undefined
    if (!user) return
    const scenario = target.scenario ?? 'free'
    const history = HISTORY_SCENARIOS.includes(scenario)
      ? messages
          .slice(0, userIdx)
          .filter(
            (m) =>
              !m.streaming &&
              !m.incomplete &&
              (m.role === 'user' || m.role === 'assistant') &&
              m.content.trim()
          )
          .slice(-8)
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      : undefined
    const requestId = target.id
    const question: AiQuestion = {
      requestId,
      scenario,
      message: user.content,
      word: target.queryWord,
      history,
      continueFrom: target.content
    }
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === requestId ? { ...m, streaming: true, incomplete: false, error: undefined } : m
      ),
      isStreaming: true
    }))
    try {
      const reply = await window.api.ai.englishAsk(question)
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === requestId
            ? { ...m, content: reply.content || m.content, sources: reply.sources, streaming: false, incomplete: false }
            : m
        ),
        isStreaming: false
      }))
    } catch (err) {
      const friendly = extractErrorMessage(err)
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === requestId
            ? { ...m, streaming: false, incomplete: true, error: friendly }
            : m
        ),
        isStreaming: false
      }))
      throw new Error(friendly)
    }
  },

  refreshConfig: async () => {
    const [config, usage] = await Promise.all([window.api.ai.getConfig(), window.api.ai.usage()])
    set({ config, usage })
  },

  refreshLists: async () => {
    const [vocab, grammar, usage] = await Promise.all([
      window.api.ai.listVocab(),
      window.api.ai.listGrammar(),
      window.api.ai.usage()
    ])
    set({ vocab, grammar, usage })
  },

  addVocab: async (payload) => {
    await window.api.ai.addVocab(payload)
    const vocab = await window.api.ai.listVocab()
    set({ vocab })
  },

  deleteVocab: async (id) => {
    await window.api.ai.deleteVocab(id)
    const vocab = await window.api.ai.listVocab()
    set({ vocab })
  },

  addGrammar: async (payload) => {
    await window.api.ai.addGrammar(payload)
    const grammar = await window.api.ai.listGrammar()
    set({ grammar })
  },

  deleteGrammar: async (id) => {
    await window.api.ai.deleteGrammar(id)
    const grammar = await window.api.ai.listGrammar()
    set({ grammar })
  }
}))
