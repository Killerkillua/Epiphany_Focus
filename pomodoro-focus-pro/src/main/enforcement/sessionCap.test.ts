import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 会话墙钟上限监视：应用开着时到点回调，不依赖倒计时轮询。
 */

const mockSettings = vi.hoisted(() => ({
  sessionMaxHours: 1
}))

vi.mock('../storage/settings', () => ({
  getSettings: () => ({ sessionMaxHours: mockSettings.sessionMaxHours }),
  setSettings: vi.fn()
}))

import { createSessionCapWatch } from './sessionCap'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  mockSettings.sessionMaxHours = 1
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSessionCapWatch', () => {
  it('恰在上限不解锁，超过 1ms 后解锁', () => {
    const onExpire = vi.fn()
    const watch = createSessionCapWatch(onExpire)
    watch.arm(Date.now())

    vi.advanceTimersByTime(3_600_000)
    expect(onExpire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    watch.clear()
  })

  it('clear 后到点不再解锁', () => {
    const onExpire = vi.fn()
    const watch = createSessionCapWatch(onExpire)
    watch.arm(Date.now())
    watch.clear()
    vi.advanceTimersByTime(3_600_000 + 1)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('开始时已经超过上限，尽快解锁', () => {
    const onExpire = vi.fn()
    const watch = createSessionCapWatch(onExpire)
    watch.arm(Date.now() - 2 * 3_600_000)
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('系统时间被拨回时重新排队，不提前解锁', () => {
    const onExpire = vi.fn()
    const watch = createSessionCapWatch(onExpire)
    const startedAt = Date.now()
    watch.arm(startedAt)

    vi.setSystemTime(startedAt - 30 * 60_000)
    vi.advanceTimersByTime(3_600_000 + 1)
    expect(onExpire).not.toHaveBeenCalled()

    vi.setSystemTime(startedAt + 3_600_000 + 1)
    vi.advanceTimersByTime(3_600_000 + 1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    watch.clear()
  })
})
