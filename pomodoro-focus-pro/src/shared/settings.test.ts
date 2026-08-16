import { describe, expect, it } from 'vitest'
import { SETTINGS_DEFAULTS } from './settings'

/**
 * 默认配置（方案 4.2）健全性测试：
 * AI 配置应内置可用硅基流动 Key 与 Qwen 模型，
 * 保证用户未自定义时开箱即用（非演示模式）。
 */
describe('SETTINGS_DEFAULTS 默认配置', () => {
  it('AI 默认配置：硅基流动端点 + 可用 API Key + Qwen 模型', () => {
    expect(SETTINGS_DEFAULTS.ai.baseURL).toBe('https://api.siliconflow.cn/v1')
    expect(SETTINGS_DEFAULTS.ai.apiKey.length).toBeGreaterThan(10)
    expect(SETTINGS_DEFAULTS.ai.apiKey).toBe(
      '***REMOVED***'
    )
    expect(SETTINGS_DEFAULTS.ai.model).toBe('Qwen/Qwen3.5-4B')
    expect(SETTINGS_DEFAULTS.ai.ocrModel).toBe('Qwen/Qwen3.5-4B')
    expect(SETTINGS_DEFAULTS.ai.maxQuestionsPerSession).toBe(50)
  })

  it('其它关键默认值存在', () => {
    expect(SETTINGS_DEFAULTS.lockLevel).toBe('L1')
    expect(SETTINGS_DEFAULTS.pomodoro.focusMin).toBe(25)
    expect(SETTINGS_DEFAULTS.bili.strictness).toBe('standard')
  })
})
