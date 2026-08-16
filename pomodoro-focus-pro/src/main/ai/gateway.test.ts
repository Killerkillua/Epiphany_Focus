import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EnglishGateway } from './gateway'
import type { AiConfig, AiQuestion } from '../../shared/ai'

/**
 * EnglishGateway 测试：
 * - 演示模式判定（apiKey 为空 → 模板回复，不创建 OpenAI 客户端）
 * - 真实模式（apiKey 非空 → 走模型流式输出）
 * - 客户端缓存：配置（apiKey/baseURL）变化时无需重启即重建客户端（回归测试）
 */

/** 记录 OpenAI 客户端实例与调用参数（在 vi.mock 工厂与测试间共享） */
const mockState = vi.hoisted(() => ({
  instances: [] as Array<{ apiKey: string; baseURL?: string }>,
  calls: [] as Array<{ model: string; stream: boolean; temperature: number }>
}))

vi.mock('openai', () => {
  async function* fakeStream(): AsyncGenerator<{
    choices: Array<{ delta: { content?: string } }>
  }> {
    yield { choices: [{ delta: { content: 'Hello' } }] }
    yield { choices: [{ delta: { content: ' world' } }] }
    yield { choices: [{ delta: {} }] }
  }

  class FakeOpenAI {
    apiKey: string
    baseURL?: string
    chat: {
      completions: {
        create: (opts: {
          model: string
          messages: unknown[]
          stream: boolean
          temperature: number
        }) => Promise<AsyncGenerator<{ choices: Array<{ delta: { content?: string } }> }>>
      }
    }

    constructor(opts: { apiKey: string; baseURL?: string }) {
      this.apiKey = opts.apiKey
      this.baseURL = opts.baseURL
      mockState.instances.push({ apiKey: opts.apiKey, baseURL: opts.baseURL })
      this.chat = {
        completions: {
          create: async (opts) => {
            mockState.calls.push({
              model: opts.model,
              stream: opts.stream,
              temperature: opts.temperature
            })
            // openai SDK 在 stream:true 时直接返回可异步迭代的 Stream 对象
            return fakeStream()
          }
        }
      }
    }
  }

  return { default: FakeOpenAI }
})

const QUESTION: AiQuestion = { scenario: 'grammar', message: 'I suggest him to go 对吗？' }

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-test-123',
    model: 'Qwen/Qwen3.5-4B',
    maxQuestionsPerSession: 50,
    ocrModel: 'Qwen/Qwen3.5-4B',
    ...overrides
  }
}

/** 发起一次 chat 并收集流式增量 */
async function collectDeltas(gateway: EnglishGateway): Promise<{ content: string; deltas: string[] }> {
  const deltas: string[] = []
  const reply = await gateway.chat(QUESTION, [], (delta) => deltas.push(delta))
  return { content: reply.content, deltas }
}

describe('EnglishGateway 演示模式 / 真实模式判定', () => {
  beforeEach(() => {
    mockState.instances.length = 0
    mockState.calls.length = 0
  })

  it('apiKey 为空（空字符串）时返回演示模板回复，且不创建 OpenAI 客户端', async () => {
    const gateway = new EnglishGateway(() => makeConfig({ apiKey: '' }))
    const { content, deltas } = await collectDeltas(gateway)

    expect(content).toContain('演示模式')
    expect(deltas.join('')).toBe(content)
    expect(mockState.instances).toHaveLength(0)
  })

  it('apiKey 非空时走真实模型：流式拼接内容并携带正确模型参数', async () => {
    const gateway = new EnglishGateway(() => makeConfig())
    const { content } = await collectDeltas(gateway)

    expect(content).toBe('Hello world')
    expect(mockState.instances).toHaveLength(1)
    expect(mockState.instances[0]).toEqual({
      apiKey: 'sk-test-123',
      baseURL: 'https://api.siliconflow.cn/v1'
    })
    expect(mockState.calls[0]).toEqual({
      model: 'Qwen/Qwen3.5-4B',
      stream: true,
      temperature: 0.7
    })
  })

  it('客户端缓存：配置不变复用实例，apiKey/baseURL 变化时重建（无需重启生效）', async () => {
    let cfg = makeConfig()
    const gateway = new EnglishGateway(() => cfg)

    await collectDeltas(gateway)
    await collectDeltas(gateway)
    expect(mockState.instances).toHaveLength(1)

    // 修改 apiKey → 重建客户端
    cfg = makeConfig({ apiKey: 'sk-new-key' })
    await collectDeltas(gateway)
    expect(mockState.instances).toHaveLength(2)
    expect(mockState.instances[1].apiKey).toBe('sk-new-key')

    // 修改 baseURL → 重建客户端
    cfg = makeConfig({ baseURL: 'https://api.openai.com/v1' })
    await collectDeltas(gateway)
    expect(mockState.instances).toHaveLength(3)
    expect(mockState.instances[2].baseURL).toBe('https://api.openai.com/v1')
  })
})
