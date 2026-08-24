import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * settings（electron-store）读写测试。
 * 覆盖根因回归：apiKey 被写成空字符串时会遮蔽 SETTINGS_DEFAULTS 中的默认 Key。
 * 临时 cwd 由 vitest.setup.ts 在模块导入前注入（POMODORO_SETTINGS_CWD）。
 * .env 注入测试：getSettings 在存储无 Key 时回退到 POMODORO_AI_API_KEY（根因 B 修复）。
 */

// electron-store / 本模块依赖 electron，测试中用空实现替换
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { getSettings, setSettings } from './settings'
import { SETTINGS_DEFAULTS } from '../../shared/settings'

/** 与 src/main/env.ts 保持一致的 .env Key 名（避免测试受宿主环境变量干扰） */
const ENV_KEY = 'POMODORO_AI_API_KEY'

describe('settings electron-store 读写（即时生效）', () => {
  beforeEach(() => {
    // 屏蔽宿主环境变量，保证「存储为空 → 无回退」的既有断言在任意机器上确定通过
    vi.stubEnv(ENV_KEY, '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })
  it('未写入时返回 SETTINGS_DEFAULTS（含可用 API Key 与 Qwen 模型）', () => {
    const s = getSettings()
    expect(s.ai).toEqual(SETTINGS_DEFAULTS.ai)
    expect(s.ai.apiKey).toBe('')
    expect(s.ai.ocrModel).toBe('Qwen/Qwen3.5-4B')
    expect(s.ai.model).toBe('Qwen/Qwen3.5-4B')
  })

  it('回归：apiKey 为空的已存储值会遮蔽默认 Key（演示模式根因）', () => {
    setSettings({ 'ai.apiKey': '' })
    expect(getSettings().ai.apiKey).toBe('')
    // 其它字段不受影响，仍回退默认值
    expect(getSettings().ai.ocrModel).toBe('Qwen/Qwen3.5-4B')
  })

  it('写入有效 Key 后立即读回（无需重启）', () => {
    setSettings({ 'ai.apiKey': 'sk-new-key' })
    expect(getSettings().ai.apiKey).toBe('sk-new-key')
  })

  it('点号路径部分更新不影响其它字段', () => {
    const baseURLBefore = getSettings().ai.baseURL
    setSettings({ 'ai.model': 'gpt-4o-mini' })
    const s = getSettings()
    expect(s.ai.baseURL).toBe(baseURLBefore)
    expect(s.ai.model).toBe('gpt-4o-mini')
    expect(s.ai.apiKey).toBe('sk-new-key')
  })

  it('env 注入：存储未配置 Key 时回退到 POMODORO_AI_API_KEY（.env），显式保存的 Key 优先', () => {
    vi.stubEnv(ENV_KEY, 'sk-env-key')
    // 存储为空 → 回退 .env Key（演示模式不再因空存储遮蔽 .env 注入）
    setSettings({ 'ai.apiKey': '' })
    expect(getSettings().ai.apiKey).toBe('sk-env-key')
    // 用户显式保存的 Key 优先于 .env 回退（BYOK 语义不变）
    setSettings({ 'ai.apiKey': 'sk-user-key' })
    expect(getSettings().ai.apiKey).toBe('sk-user-key')
    // 恢复存储为空，避免影响其它用例
    setSettings({ 'ai.apiKey': '' })
  })
})
