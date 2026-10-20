import { describe, expect, it } from 'vitest'
import { SETTINGS_DEFAULTS } from './settings'

/**
 * 默认配置（方案 4.2）健全性测试：
 * AI 配置内置硅基流动端点与 Qwen 模型；API Key 默认留空（演示模式），
 * 密钥经 .env 注入（见 commit 3b7fec8 移除硬编码密钥）。
 */
describe('SETTINGS_DEFAULTS 默认配置', () => {
  it('AI 默认配置：硅基流动端点 + Qwen 模型（API Key 留空 = 演示模式）', () => {
    expect(SETTINGS_DEFAULTS.ai.baseURL).toBe('https://api.siliconflow.cn/v1')
    expect(SETTINGS_DEFAULTS.ai.apiKey).toBe('')
    expect(SETTINGS_DEFAULTS.ai.model).toBe('Qwen/Qwen3.5-4B')
    expect(SETTINGS_DEFAULTS.ai.ocrModel).toBe('Qwen/Qwen3.5-4B')
    expect(SETTINGS_DEFAULTS.ai.maxQuestionsPerSession).toBe(50)
  })

  it('其它关键默认值存在', () => {
    expect(SETTINGS_DEFAULTS.lockLevel).toBe('L1')
    expect(SETTINGS_DEFAULTS.pomodoro.focusMin).toBe(25)
    expect(SETTINGS_DEFAULTS.bili.strictness).toBe('standard')
    expect(SETTINGS_DEFAULTS.sessionOverlay).toBe(true)
  })
})
