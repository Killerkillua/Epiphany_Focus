import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEnglishStore } from './englishStore'

/**
 * 渲染层 englishStore 测试：
 * - init() 从主进程拉取真实配置（含 API Key）
 * - 设置页保存后经 settings:changed 事件实时刷新配置，无需重进页面
 */

type AiConfigLike = {
  baseURL: string
  apiKey: string
  model: string
  maxQuestionsPerSession: number
  ocrModel: string
}

const listeners = new Map<string, (payload: unknown) => void>()

const config = (apiKey: string): AiConfigLike => ({
  baseURL: 'https://api.siliconflow.cn/v1',
  apiKey,
  model: 'Qwen/Qwen3.5-4B',
  maxQuestionsPerSession: 50,
  ocrModel: 'Qwen/Qwen3.5-4B'
})

vi.stubGlobal('window', {
  api: {
    events: {
      settings: { changed: 'settings:changed' },
      ai: { chunk: 'ai:chunk' }
    },
    on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
    ai: {
      getConfig: vi.fn(async (): Promise<AiConfigLike> => config('sk-saved')),
      usage: vi.fn(async () => ({ used: 1, limit: 50 })),
      listVocab: vi.fn(async () => []),
      listGrammar: vi.fn(async () => [])
    }
  }
})

const api = window.api as unknown as {
  ai: {
    getConfig: ReturnType<typeof vi.fn>
    usage: ReturnType<typeof vi.fn>
    listVocab: ReturnType<typeof vi.fn>
    listGrammar: ReturnType<typeof vi.fn>
  }
}

describe('englishStore 配置加载与实时刷新', () => {
  beforeEach(() => {
    api.ai.getConfig.mockResolvedValue(config('sk-saved'))
    api.ai.usage.mockResolvedValue({ used: 1, limit: 50 })
    api.ai.listVocab.mockResolvedValue([])
    api.ai.listGrammar.mockResolvedValue([])
  })

  it('init() 从主进程拉取配置（含 API Key），页面据此判断是否演示模式', async () => {
    await useEnglishStore.getState().init()

    expect(useEnglishStore.getState().config.apiKey).toBe('sk-saved')
    expect(useEnglishStore.getState().config.model).toBe('Qwen/Qwen3.5-4B')
    expect(useEnglishStore.getState().usage).toEqual({ used: 1, limit: 50 })
  })

  it('设置页保存后经 settings:changed 广播实时刷新配置（无需重进页面）', async () => {
    await useEnglishStore.getState().init()

    api.ai.getConfig.mockResolvedValue(config('sk-new-key'))
    api.ai.usage.mockResolvedValue({ used: 2, limit: 50 })

    const handler = listeners.get('settings:changed')
    expect(handler).toBeDefined()
    handler?.({ ai: config('sk-new-key') })

    await vi.waitFor(() => {
      expect(useEnglishStore.getState().config.apiKey).toBe('sk-new-key')
    })
    expect(useEnglishStore.getState().usage.used).toBe(2)
  })
})
