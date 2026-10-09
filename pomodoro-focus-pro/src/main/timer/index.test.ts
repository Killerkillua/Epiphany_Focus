import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimerService } from './index'
import type { TimerSnapshot } from '../../shared/types'

/**
 * 计时器内核测试（方案 2.5 主进程权威状态）。
 *
 * 时钟方案：TimerService 基于 process.hrtime.bigint()（单调时钟）+ setInterval。
 * 测试中：
 * - spy 接管 process.hrtime.bigint（模拟单调时钟推进，系统时间篡改不影响计时）
 * - vi.useFakeTimers 控制 setInterval（每秒 tick 由 advanceTimersByTime 精确驱动）
 * 使 elapsed / remaining / 到点判定完全确定。
 */

/** 模拟单调时钟的当前毫秒（相对任意起点，TimerService 只用差值） */
let nowMs = 0

function advance(ms: number): void {
  nowMs += ms
  vi.advanceTimersByTime(ms)
}

function makeService(
  onTick = vi.fn(),
  onComplete = vi.fn()
): {
  timer: TimerService
  onTick: ReturnType<typeof vi.fn>
  onComplete: ReturnType<typeof vi.fn>
} {
  return { timer: new TimerService(onTick, onComplete), onTick, onComplete }
}

beforeEach(() => {
  vi.useFakeTimers()
  nowMs = 0
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => BigInt(nowMs * 1_000_000))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('初始快照', () => {
  it('未开始时为 idle，默认 25 分钟、零进度', () => {
    const { timer } = makeService()
    const snap = timer.getSnapshot()
    expect(snap.status).toBe('idle')
    expect(snap.mode).toBe('countdown')
    expect(snap.durationMs).toBe(25 * 60_000)
    expect(snap.elapsedMs).toBe(0)
    expect(snap.remainingMs).toBe(25 * 60_000)
    expect(snap.completedPomodoros).toBe(0)
  })
})

describe('start（倒计时开始）', () => {
  it('启动后为 running，剩余 = 目标时长，并立即推一次 onTick', () => {
    const { timer, onTick } = makeService()
    const snap = timer.start({ mode: 'countdown', durationMs: 10_000 })
    expect(snap.status).toBe('running')
    expect(snap.mode).toBe('countdown')
    expect(snap.durationMs).toBe(10_000)
    expect(snap.elapsedMs).toBe(0)
    expect(snap.remainingMs).toBe(10_000)
    expect(onTick).toHaveBeenCalledTimes(1)
    timer.stop()
  })

  it('时长钳制：<1s 取 1s；非法值（NaN）回退默认 25 分钟', () => {
    const { timer } = makeService()
    expect(timer.start({ mode: 'countdown', durationMs: 100 }).durationMs).toBe(1_000)
    expect(timer.start({ mode: 'countdown', durationMs: Number.NaN }).durationMs).toBe(25 * 60_000)
    timer.stop()
  })

  it('start 新会话保留已完成番茄计数（跨轮不丢失）', () => {
    const { timer } = makeService()
    timer.start({ mode: 'countdown', durationMs: 1_000 })
    advance(1_000) // 完成第 1 个番茄
    expect(timer.getSnapshot().completedPomodoros).toBe(1)

    timer.start({ mode: 'countdown', durationMs: 10_000 })
    expect(timer.getSnapshot().completedPomodoros).toBe(1)
    timer.stop()
  })
})

describe('倒计时推进 / 暂停 / 恢复', () => {
  it('running 时 elapsed/remaining 随单调时钟推进（不受系统时间影响）', () => {
    const { timer } = makeService()
    timer.start({ mode: 'countdown', durationMs: 10_000 })
    advance(3_000)
    let snap = timer.getSnapshot()
    expect(snap.elapsedMs).toBe(3_000)
    expect(snap.remainingMs).toBe(7_000)

    advance(4_500)
    snap = timer.getSnapshot()
    expect(snap.elapsedMs).toBe(7_500)
    expect(snap.remainingMs).toBe(2_500)
    timer.stop()
  })

  it('pause 冻结计时；resume 从冻结点继续', () => {
    const { timer } = makeService()
    timer.start({ mode: 'countdown', durationMs: 10_000 })
    advance(3_000)
    expect(timer.pause().status).toBe('paused')

    // 暂停期间时钟继续流逝，但 elapsed 冻结
    advance(2_000)
    let snap = timer.getSnapshot()
    expect(snap.elapsedMs).toBe(3_000)
    expect(snap.remainingMs).toBe(7_000)

    // 恢复后从 baseElapsed 继续累计
    expect(timer.resume().status).toBe('running')
    advance(2_000)
    snap = timer.getSnapshot()
    expect(snap.elapsedMs).toBe(5_000)
    expect(snap.remainingMs).toBe(5_000)
    timer.stop()
  })

  it('非 running 时 pause / 非 paused 时 resume 为幂等无副作用', () => {
    const { timer, onTick } = makeService()
    expect(timer.pause().status).toBe('idle') // idle 下 pause 无效
    timer.start({ mode: 'countdown', durationMs: 10_000 })
    expect(timer.resume().status).toBe('running') // running 下 resume 无效
    expect(timer.pause().status).toBe('paused')
    expect(timer.pause().status).toBe('paused') // 重复 pause 幂等
    // start + pause 各一次推送；重复 pause 不重复推送（按秒去重）
    expect(onTick).toHaveBeenCalledTimes(2)
  })
})

describe('到点完成（countdown）', () => {
  it('finishIfElapsed：倒计时已走完但轮询未到时立即完成', () => {
    const { timer, onComplete } = makeService()
    timer.start({ mode: 'countdown', durationMs: 5_000 })
    nowMs += 4_000
    expect(timer.finishIfElapsed()).toBe(false)
    expect(onComplete).not.toHaveBeenCalled()

    nowMs += 1_000
    expect(timer.getSnapshot().status).toBe('running')
    expect(timer.finishIfElapsed()).toBe(true)
    expect(timer.getSnapshot().status).toBe('finished')
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(timer.finishIfElapsed()).toBe(false)
  })

  it('finishIfElapsed：正序计时不按计划时长自动完成', () => {
    const { timer, onComplete } = makeService()
    timer.start({ mode: 'countup', durationMs: 5_000 })
    nowMs += 10_000
    expect(timer.finishIfElapsed()).toBe(false)
    expect(onComplete).not.toHaveBeenCalled()
    timer.stop()
  })

  it('到点：status=finished、elapsed=时长、remaining=0、番茄 +1、onComplete 触发', () => {
    const { timer, onTick, onComplete } = makeService()
    timer.start({ mode: 'countdown', durationMs: 5_000 })
    advance(5_000)

    const snap = timer.getSnapshot()
    expect(snap.status).toBe('finished')
    expect(snap.elapsedMs).toBe(5_000)
    expect(snap.remainingMs).toBe(0)
    expect(snap.completedPomodoros).toBe(1)
    expect(onComplete).toHaveBeenCalledTimes(1)

    const completeSnap = onComplete.mock.calls[0][0] as TimerSnapshot
    expect(completeSnap.status).toBe('finished')
    expect(completeSnap.longRestSuggestion).toBe(false)
    // 到点后计时停止，不再推进
    advance(2_000)
    expect(timer.getSnapshot().elapsedMs).toBe(5_000)
  })

  it('完成态到点推送不因去重被吞（finished 强制 emit）', () => {
    const { timer, onTick } = makeService()
    timer.start({ mode: 'countdown', durationMs: 5_000 })
    // 分步推进：单调时钟（nowMs）与 setInterval 同步前进，让每秒 tick 依次触发
    // start(1) + 每秒 tick(1..4s) + 到点 finished(5s) = 6 次；finished 快照必然被推送
    for (let i = 0; i < 5; i++) advance(1_000)
    expect(onTick).toHaveBeenCalled()
    const last = onTick.mock.calls.at(-1)![0] as TimerSnapshot
    expect(last.status).toBe('finished')
  })

  it('满 4 个番茄：第 4 次完成返回 longRestSuggestion=true 且计数归零', () => {
    const longRests: boolean[] = []
    const { timer } = makeService(
      vi.fn(),
      vi.fn((snap: TimerSnapshot) => longRests.push(snap.longRestSuggestion))
    )
    for (let i = 0; i < 4; i++) {
      timer.start({ mode: 'countdown', durationMs: 5_000 })
      advance(5_000)
    }
    expect(longRests).toEqual([false, false, false, true])
    expect(timer.getSnapshot().completedPomodoros).toBe(0)
  })
})

describe('stop（手动结束）', () => {
  it('countdown 未到点手动 stop = 放弃：不计番茄，状态回 idle', () => {
    const { timer, onComplete } = makeService()
    timer.start({ mode: 'countdown', durationMs: 60_000 })
    advance(10_000)
    const snap = timer.stop()
    expect(snap.status).toBe('idle')
    expect(snap.completedPomodoros).toBe(0)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('countup 正序手动 stop：超过 5s 计入一个番茄，但不触发 onComplete（无到点通知）', () => {
    const { timer, onComplete } = makeService()
    timer.start({ mode: 'countup', durationMs: 0 })
    advance(6_000)
    const snap = timer.stop()
    expect(snap.status).toBe('idle')
    expect(snap.completedPomodoros).toBe(1)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('countup 不足 5s 手动 stop：不计数', () => {
    const { timer } = makeService()
    timer.start({ mode: 'countup', durationMs: 0 })
    advance(3_000)
    expect(timer.stop().completedPomodoros).toBe(0)
  })

  it('finished 状态 stop：仅复位为 idle，不再重复计数', () => {
    const { timer } = makeService()
    timer.start({ mode: 'countdown', durationMs: 5_000 })
    advance(5_000)
    expect(timer.getSnapshot().completedPomodoros).toBe(1)
    const snap = timer.stop()
    expect(snap.status).toBe('idle')
    expect(snap.completedPomodoros).toBe(1) // 计数不清零（累计到长休息间隔）
    timer.stop() // idle 下 stop 无副作用
    expect(timer.getSnapshot().status).toBe('idle')
  })
})

describe('restore（重启恢复，方案 2.5 防绕过）', () => {
  it('从持久化 elapsed 恢复：剩余 = duration - elapsed', () => {
    const { timer } = makeService()
    const snap = timer.restore({ mode: 'countdown', durationMs: 10_000, elapsedMs: 6_000 })
    expect(snap.status).toBe('running')
    expect(snap.elapsedMs).toBe(6_000)
    expect(snap.remainingMs).toBe(4_000)
    timer.stop()
  })

  it('elapsed 超限钳到 duration（remaining=0，到点即触发）；负值钳到 0', () => {
    const { timer } = makeService()
    timer.restore({ mode: 'countdown', durationMs: 10_000, elapsedMs: 99_000 })
    expect(timer.getSnapshot().elapsedMs).toBe(10_000)
    expect(timer.getSnapshot().remainingMs).toBe(0)
    timer.stop()

    const { timer: t2 } = makeService()
    t2.restore({ mode: 'countdown', durationMs: 10_000, elapsedMs: -5 })
    expect(t2.getSnapshot().elapsedMs).toBe(0)
    expect(t2.getSnapshot().remainingMs).toBe(10_000)
    t2.stop()
  })

  it('durationMs 钳制到至少 1s', () => {
    const { timer } = makeService()
    expect(timer.restore({ mode: 'countdown', durationMs: 100, elapsedMs: 0 }).durationMs).toBe(
      1_000
    )
    timer.stop()
  })

  it('恢复后的计时继续推进（恢复不是静态快照）', () => {
    const { timer } = makeService()
    timer.restore({ mode: 'countdown', durationMs: 10_000, elapsedMs: 6_000 })
    advance(2_000)
    const snap = timer.getSnapshot()
    expect(snap.elapsedMs).toBe(8_000)
    expect(snap.remainingMs).toBe(2_000)
    timer.stop()
  })
})
