import { create } from 'zustand'
import type {
  AddGrammarPayload,
  AddVocabPayload,
  AiConfig,
  AiQuestion,
  AiScenario,
  AiSource,
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
  /** 该条关联的提问词（用于一键入本） */
  queryWord?: string
}

const DEFAULT_CONFIG: AiConfig = {
  baseURL: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'deepseek-ai/DeepSeek-V3',
  maxQuestionsPerSession: 50,
  ocrModel: 'deepseek-ai/DeepSeek-OCR'
}

interface EnglishStore {
  messages: ChatMessage[]
  isStreaming: boolean
  config: AiConfig
  usage: AiUsage
  vocab: VocabEntry[]
  grammar: GrammarPoint[]
  init: () => Promise<void>
  ask: (scenario: AiScenario, message: string, word?: string) => Promise<void>
  saveConfig: (patch: Partial<AiConfig>) => Promise<void>
  refreshLists: () => Promise<void>
  addVocab: (payload: AddVocabPayload) => Promise<void>
  deleteVocab: (id: number) => Promise<void>
  addGrammar: (payload: AddGrammarPayload) => Promise<void>
  deleteGrammar: (id: number) => Promise<void>
}

let chunkSubscribed = false

export const useEnglishStore = create<EnglishStore>((set, get) => ({
  messages: [],
  isStreaming: false,
  config: DEFAULT_CONFIG,
  usage: { used: 0, limit: 50 },
  vocab: [],
  grammar: [],

  init: async () => {
    if (!chunkSubscribed) {
      chunkSubscribed = true
      window.api.on<{
        requestId: string
        delta: string
        done: boolean
        content?: string
        sources?: AiSource[]
      }>('ai:chunk', (chunk) => {
        if (!chunk.requestId || !get().isStreaming) return
        set((state) => {
          const messages = state.messages.map((m) => {
            if (m.id !== chunk.requestId) return m
            if (chunk.done) {
              return {
                ...m,
                content: chunk.content ?? m.content,
                sources: chunk.sources ?? m.sources,
                streaming: false
              }
            }
            return { ...m, content: m.content + chunk.delta }
          })
          const isStreaming = chunk.done
            ? false
            : messages.some((m) => m.streaming)
          return { messages, isStreaming }
        })
      })
    }
    const [config, usage, vocab, grammar] = await Promise.all([
      window.api.ai.getConfig(),
      window.api.ai.usage(),
      window.api.ai.listVocab(),
      window.api.ai.listGrammar()
    ])
    set({ config, usage, vocab, grammar })
  },

  ask: async (scenario, message, word) => {
    const trimmed = message.trim()
    if (!trimmed || get().isStreaming) return

    const requestId = crypto.randomUUID()
    const question: AiQuestion = { scenario, message: trimmed, word }

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: trimmed, sources: [] }
    const assistantMsg: ChatMessage = {
      id: requestId,
      role: 'assistant',
      content: '',
      sources: [],
      streaming: true,
      queryWord: word ?? trimmed
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
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === requestId
            ? { ...m, content: m.content || '⚠️ 请求失败', streaming: false }
            : m
        ),
        isStreaming: false
      }))
      throw err instanceof Error ? err : new Error(String(err))
    }
  },

  saveConfig: async (patch) => {
    const config = await window.api.ai.setConfig(patch)
    set({ config })
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
