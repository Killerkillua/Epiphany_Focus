import { describe, expect, it, vi } from 'vitest'

/**
 * .env 加载模块测试（审查 C1 配套：API Key 走 .env 存储）。
 * 仅测试纯函数 parseEnvFile，不依赖 Electron 运行时。
 */

vi.mock('electron', () => ({
  app: { getAppPath: () => '/' }
}))

import { ENV_KEY_API_KEY, parseEnvFile } from './env'

describe('parseEnvFile 轻量 .env 解析', () => {
  it('解析 KEY=VALUE、注释与空行', () => {
    const vars = parseEnvFile([
      '# 注释行',
      '',
      `POMODORO_AI_API_KEY=sk-abc123`,
      'EMPTY=',
      '  带空格键 = 值  '
    ].join('\n'))
    expect(vars[ENV_KEY_API_KEY]).toBe('sk-abc123')
    expect(vars.EMPTY).toBe('')
    expect(vars['带空格键']).toBe('值')
  })

  it('支持单/双引号包裹的值', () => {
    const vars = parseEnvFile('KEY1="quoted value"\nKEY2=\'single\'')
    expect(vars.KEY1).toBe('quoted value')
    expect(vars.KEY2).toBe('single')
  })

  it('忽略非法行与内联注释前的注释行', () => {
    const vars = parseEnvFile('=novalue\n# comment\nA=B')
    expect(vars.A).toBe('B')
    expect(vars['']).toBeUndefined()
  })
})
