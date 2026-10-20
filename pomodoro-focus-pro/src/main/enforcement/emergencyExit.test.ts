import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/settings'

/**
 * 紧急退出机制测试（方案 2.10）。
 * - settings 存储以 vi.mock('../storage/settings') 替换为进程内状态对象
 *   （getSettings/setSettings 模拟 electron-store 点号写入语义）
 * - 模块级失败计数 / 冷却时间戳通过 vi.resetModules + 动态 import 每用例重置
 * - 时间用 vi.useFakeTimers + setSystemTime 精确控制（Date.now 驱动的冷却）
 * - setRecoveryCode / verifyOldCode / verifyRecoveryCode 为异步（H-02 bcrypt 异步化），
 *   所有调用使用 await。
 * - bcryptjs 内部用 setImmediate 调度，会被 vi.useFakeTimers 冻结导致 await 永不 resolve，
 *   故 mock 成"基于明文编码"的即时异步哈希/比对（不含任何定时器）。
 */

const mockSettings = vi.hoisted(() => {
  const state: Record<string, unknown> = { recoveryCodeHash: null, sessionMaxHours: 4 }
  return {
    state,
    getSettings: vi.fn((): AppSettings => ({ ...state }) as unknown as AppSettings),
    setSettings: vi.fn((entries: Record<string, unknown>): AppSettings => {
      Object.assign(state, entries)
      return { ...state } as unknown as AppSettings
    })
  }
})

vi.mock('../storage/settings', () => ({
  getSettings: mockSettings.getSettings,
  setSettings: mockSettings.setSettings
}))

// H-02：异步 bcrypt 在 fake timers 下不可用，mock 为即时解析的异步版本
vi.mock('bcryptjs', () => {
  const encode = (code: string): string => `$2a$10$${Buffer.from(code).toString('base64')}`
  return {
    default: {
      hash: vi.fn(async (code: string) => encode(code)),
      compare: vi.fn(async (code: string, hash: string) => hash === encode(code))
    }
  }
})

type EmergencyExitModule = typeof import('./emergencyExit')

let exit: EmergencyExitModule

/** 初始设置：有恢复码哈希（setRecoveryCode 经 mock 的 setSettings 写入 state），默认 4h 上限 */
async function seedHash(code = 'Secret12'): Promise<void> {
  await exit.setRecoveryCode(code)
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  // 重置存储状态到默认
  for (const k of Object.keys(mockSettings.state)) delete mockSettings.state[k]
  mockSettings.state.recoveryCodeHash = null
  mockSettings.state.sessionMaxHours = 4
  vi.clearAllMocks()
  // 重置模块级失败计数 / 冷却（重新加载模块）
  vi.resetModules()
  exit = await import('./emergencyExit')
})

afterEach(() => {
  vi.useRealTimers()
})

/** 当前系统时间（ms） */
function now(): number {
  return Date.now()
}

function advance(ms: number): void {
  vi.advanceTimersByTime(ms)
}

describe('hasRecoveryCode / setRecoveryCode', () => {
  it('未设置时返回 false；设置后返回 true', async () => {
    expect(exit.hasRecoveryCode()).toBe(false)
    await exit.setRecoveryCode('Secret12')
    expect(exit.hasRecoveryCode()).toBe(true)
  })

  it('setRecoveryCode 长度 <8 位抛错，且不写入存储', async () => {
    await expect(exit.setRecoveryCode('Ab1!234')).rejects.toThrow('至少 8 位')
    await expect(exit.setRecoveryCode('')).rejects.toThrow('至少 8 位')
    expect(mockSettings.setSettings).not.toHaveBeenCalled()
  })

  it('setRecoveryCode 拒绝弱码：单一重复字符 / 仅一类字符', async () => {
    await expect(exit.setRecoveryCode('aaaaaaaa')).rejects.toThrow('重复')
    await expect(exit.setRecoveryCode('abcdefgh')).rejects.toThrow('两类')
    await expect(exit.setRecoveryCode('12345678')).rejects.toThrow('两类')
    expect(mockSettings.setSettings).not.toHaveBeenCalled()
  })

  it('存储的是 bcrypt 哈希而非明文（不可逆存储）', async () => {
    await exit.setRecoveryCode('Secret12')
    const stored = mockSettings.setSettings.mock.calls.at(-1)![0] as { recoveryCodeHash: string }
    expect(stored.recoveryCodeHash).toBeTruthy()
    expect(stored.recoveryCodeHash).not.toContain('Secret12')
    expect(stored.recoveryCodeHash).toMatch(/^\$2[aby]\$/)
  })
})

describe('verifyOldCode（修改恢复码前的旧码校验，CR-02）', () => {
  it('未设置过恢复码时直接返回 true（首次设置无需旧码）', async () => {
    expect(await exit.verifyOldCode('anything')).toBe(true)
  })

  it('已设置：旧码正确返回 true，错误/空返回 false', async () => {
    await seedHash('Secret12')
    expect(await exit.verifyOldCode('Secret12')).toBe(true)
    expect(await exit.verifyOldCode('wrong')).toBe(false)
    expect(await exit.verifyOldCode('')).toBe(false)
  })

  it('纯比对：错误旧码不触发失败计数 / 冷却（区别于紧急退出路径）', async () => {
    await seedHash('Secret12')
    await exit.verifyOldCode('wrong')
    await exit.verifyOldCode('wrong')
    // 若走了失败计数路径，第 3 次会锁定；此处应仍可正常比对
    expect(await exit.verifyOldCode('Secret12')).toBe(true)
  })
})

describe('verifyRecoveryCode（紧急退出验证）', () => {
  it('未设置恢复码：返回失败提示', async () => {
    const r = await exit.verifyRecoveryCode('Secret12', 'L1')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('尚未设置')
  })

  it('正确恢复码 → ok；成功不触发冷却', async () => {
    await seedHash()
    const r = await exit.verifyRecoveryCode('Secret12', 'L1')
    expect(r).toEqual({ ok: true })
  })

  it('错误累计：前 2 次提示剩余次数，第 3 次锁定 1 分钟', async () => {
    await seedHash()
    expect((await exit.verifyRecoveryCode('bad1', 'L1')).error).toContain('还可尝试 2 次')
    expect((await exit.verifyRecoveryCode('bad2', 'L1')).error).toContain('还可尝试 1 次')

    const third = await exit.verifyRecoveryCode('bad3', 'L1')
    expect(third.ok).toBe(false)
    expect(third.error).toContain('锁定 1 分钟')
    expect(third.retryInSec).toBe(60)

    // 锁定期间即使输入正确码也拒绝
    const locked = await exit.verifyRecoveryCode('Secret12', 'L1')
    expect(locked.ok).toBe(false)
    expect(locked.error).toContain('尝试次数过多')
    expect(locked.retryInSec).toBeLessThanOrEqual(60)
  })

  it('冷却到期后恢复可验证', async () => {
    await seedHash()
    await exit.verifyRecoveryCode('bad1', 'L1')
    await exit.verifyRecoveryCode('bad2', 'L1')
    await exit.verifyRecoveryCode('bad3', 'L1') // 锁定
    advance(60_000) // 1 分钟冷却结束
    expect(await exit.verifyRecoveryCode('Secret12', 'L1')).toEqual({ ok: true })
  })

  it('验证成功清零失败计数（失败计数不跨成功累计）', async () => {
    await seedHash()
    await exit.verifyRecoveryCode('bad1', 'L1')
    expect(await exit.verifyRecoveryCode('Secret12', 'L1')).toEqual({ ok: true })
    // 计数已清零：接下来连续 2 次错误不锁定，第 3 次才锁定
    expect((await exit.verifyRecoveryCode('bad1', 'L1')).error).toContain('还可尝试 2 次')
    expect((await exit.verifyRecoveryCode('bad2', 'L1')).error).toContain('还可尝试 1 次')
    expect((await exit.verifyRecoveryCode('bad3', 'L1')).retryInSec).toBe(60)
  })

  it('L2 额外 30s 冷却（startL2CoolDown 后即使正确码也拒绝）', async () => {
    await seedHash()
    exit.startL2CoolDown()
    const r = await exit.verifyRecoveryCode('Secret12', 'L2')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('L2 冷却中')
    expect(r.retryInSec).toBe(30)
    // 冷却到期后正常
    advance(30_000)
    expect(await exit.verifyRecoveryCode('Secret12', 'L2')).toEqual({ ok: true })
  })

  it('L2 冷却判定与 level 参数无关（当前实现对所有级别生效，level 由调用方配合 startL2CoolDown 控制）', async () => {
    await seedHash()
    exit.startL2CoolDown()
    const r = await exit.verifyRecoveryCode('Secret12', 'L0')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('L2 冷却中')
  })
})

describe('失败计数 / 锁定持久化与指数退避', () => {
  /** 模拟杀进程重启：重新加载模块，但存储状态（mockSettings.state）保留 */
  async function restart(): Promise<void> {
    vi.resetModules()
    exit = await import('./emergencyExit')
  }

  it('重启后失败计数不清零：重启前错 2 次，重启后再错 1 次即锁定', async () => {
    await seedHash()
    await exit.verifyRecoveryCode('bad1', 'L1')
    await exit.verifyRecoveryCode('bad2', 'L1')
    await restart()
    const third = await exit.verifyRecoveryCode('bad3', 'L1')
    expect(third.error).toContain('已锁定')
  })

  it('重启后锁定仍然有效，且即使输入正确码也被拒绝', async () => {
    await seedHash()
    for (const c of ['bad1', 'bad2', 'bad3']) await exit.verifyRecoveryCode(c, 'L1')
    await restart()
    const r = await exit.verifyRecoveryCode('Secret12', 'L1')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('尝试次数过多')
  })

  it('重启后 L2 冷却仍然有效', async () => {
    await seedHash()
    exit.startL2CoolDown()
    await restart()
    const r = await exit.verifyRecoveryCode('Secret12', 'L2')
    expect(r.error).toContain('L2 冷却中')
  })

  it('指数退避：第 1/2/3 轮锁定依次为 1 / 2 / 4 分钟', async () => {
    await seedHash()
    const expected = [60, 120, 240]
    for (const sec of expected) {
      await exit.verifyRecoveryCode('bad', 'L1')
      await exit.verifyRecoveryCode('bad', 'L1')
      const r = await exit.verifyRecoveryCode('bad', 'L1')
      expect(r.retryInSec).toBe(sec)
      advance(sec * 1000)
    }
  })

  it('锁定时长封顶 6 小时', () => {
    expect(exit.lockDurationMs(0)).toBe(60_000)
    expect(exit.lockDurationMs(30)).toBe(6 * 3_600_000)
  })

  it('验证成功后退避轮数清零', async () => {
    await seedHash()
    for (const c of ['b1', 'b2', 'b3']) await exit.verifyRecoveryCode(c, 'L1')
    advance(60_000)
    expect(await exit.verifyRecoveryCode('Secret12', 'L1')).toEqual({ ok: true })
    for (const c of ['b1', 'b2']) await exit.verifyRecoveryCode(c, 'L1')
    expect((await exit.verifyRecoveryCode('b3', 'L1')).retryInSec).toBe(60)
  })

  it('失败计数写入持久化存储', async () => {
    await seedHash()
    await exit.verifyRecoveryCode('bad', 'L1')
    expect((mockSettings.state.emergencyGuard as { failCount: number }).failCount).toBe(1)
  })
})

describe('isSessionExpired（会话上限，默认 4h）', () => {
  it('超过上限判定过期；恰在上限不判定（严格大于）', () => {
    mockSettings.state.sessionMaxHours = 4
    const maxMs = 4 * 3_600_000
    expect(exit.isSessionExpired(now() - maxMs - 1)).toBe(true)
    expect(exit.isSessionExpired(now() - maxMs)).toBe(false)
    expect(exit.isSessionExpired(now())).toBe(false)
  })

  it('sessionMaxHours 可配置（1h 上限）', () => {
    mockSettings.state.sessionMaxHours = 1
    expect(exit.isSessionExpired(now() - 2 * 3_600_000)).toBe(true)
    expect(exit.isSessionExpired(now() - 30 * 60_000)).toBe(false)
  })
})

describe('assertExitSafety（强制会话前置条件）', () => {
  it('L0 无需恢复码即可开始', () => {
    expect(() => exit.assertExitSafety('L0')).not.toThrow()
  })

  it('L1/L2 未设置恢复码时抛错', () => {
    expect(() => exit.assertExitSafety('L1')).toThrow('恢复码')
    expect(() => exit.assertExitSafety('L2')).toThrow('恢复码')
  })

  it('L1/L2 已设置恢复码时通过', async () => {
    await seedHash()
    expect(() => exit.assertExitSafety('L1')).not.toThrow()
    expect(() => exit.assertExitSafety('L2')).not.toThrow()
  })
})
