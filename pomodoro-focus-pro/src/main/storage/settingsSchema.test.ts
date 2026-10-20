import { describe, expect, it } from 'vitest'
import { validateRendererSetting } from './settingsSchema'

describe('settingsSchema 渲染层设置校验', () => {
  it('放行合法值', () => {
    expect(validateRendererSetting('lockLevel', 'L2')).toBe('L2')
    expect(validateRendererSetting('pomodoro.focusMin', 25)).toBe(25)
    expect(validateRendererSetting('backup.time', '03:30')).toBe('03:30')
    expect(validateRendererSetting('ai.baseURL', 'https://api.siliconflow.cn/v1')).toContain(
      'https://'
    )
    expect(validateRendererSetting('ai.baseURL', 'http://localhost:11434/v1')).toContain('http://')
  })

  it('拒绝未知键与原型污染键', () => {
    expect(() => validateRendererSetting('recoveryCodeHash', 'x')).toThrow()
    expect(() => validateRendererSetting('__proto__', {})).toThrow()
    expect(() => validateRendererSetting('constructor', 1)).toThrow()
  })

  it('拒绝类型错误与越界值', () => {
    expect(() => validateRendererSetting('lockLevel', 'L9')).toThrow()
    expect(() => validateRendererSetting('pomodoro.focusMin', '25')).toThrow()
    expect(() => validateRendererSetting('pomodoro.focusMin', 0)).toThrow()
    expect(() => validateRendererSetting('pomodoro.focusMin', 1.5)).toThrow()
    expect(() => validateRendererSetting('backup.time', '25:99')).toThrow()
    expect(() => validateRendererSetting('telemetryEnabled', 1)).toThrow()
  })

  it('端点必须 https（回环地址除外）且不含凭据', () => {
    expect(() => validateRendererSetting('ai.baseURL', 'http://evil.example/v1')).toThrow()
    expect(() => validateRendererSetting('ai.baseURL', 'file:///etc/passwd')).toThrow()
    expect(() => validateRendererSetting('ai.baseURL', 'https://u:p@evil.example')).toThrow()
  })

  it('备份目录必须是绝对路径', () => {
    expect(validateRendererSetting('backup.directory', '')).toBe('')
    expect(() => validateRendererSetting('backup.directory', '..\\x')).toThrow()
  })
})
