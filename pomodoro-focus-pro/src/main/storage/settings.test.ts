import { describe, expect, it, vi } from 'vitest'

/**
 * settings（electron-store）读写测试。
 * 覆盖根因回归：apiKey 被写成空字符串时会遮蔽 SETTINGS_DEFAULTS 中的默认 Key。
 * 临时 cwd 由 vitest.setup.ts 在模块导入前注入（POMODORO_SETTINGS_CWD）。
 */

// electron-store / 本模块依赖 electron，测试中用空实现替换
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { getSettings, setSettings } from './settings'
import { SETTINGS_DEFAULTS } from '../../shared/settings'

describe('settings electron-store 读写（即时生效）', () => {
  it('未写入时返回 SETTINGS_DEFAULTS（含可用 API Key 与 Qwen 模型）', () => {
    const s = getSettings()
    expect(s.ai).toEqual(SETTINGS_DEFAULTS.ai)
    expect(s.ai.apiKey).toBe('***REMOVED***')
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
})
