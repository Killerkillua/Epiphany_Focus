import type { TimerMode, TimerOptions, TimerSnapshot, TimerStatus } from '../../shared/types'

/**
 * 番茄钟计时服务（主进程权威状态）。
 * - 基于单调时钟（process.hrtime.bigint()），系统时间篡改不影响计时
 * - 与 UI/渲染层解耦：渲染层崩溃或刷新，计时继续
 * - 由 focus 模块注入 onTick / onComplete 回调（发 IPC / 通知）
 */
export class TimerService {
  private mode: TimerMode = 'countdown'
  private durationMs = 25 * 60 * 1000
  private status: TimerStatus = 'idle'
  /** 已累计的计时毫秒（暂停时冻结） */
  private baseElapsedMs = 0
  /** 本轮开始时的单调时间戳 */
  private runStartMs = 0
  /** 距上次长休息已完成的番茄数（0-3，满 4 归零） */
  private completedPomodoros = 0
  private interval: NodeJS.Timeout | null = null
  private lastEmittedKey = ''

  constructor(
    private readonly onTick: (snapshot: TimerSnapshot) => void,
    private readonly onComplete: (snapshot: TimerSnapshot) => void
  ) {}

  /** 当前单调时钟毫秒 */
  private static nowMs(): number {
    return Number(process.hrtime.bigint() / 1000000n)
  }

  getSnapshot(): TimerSnapshot {
    const elapsedMs = this.status === 'running' ? this.getElapsedMs() : this.baseElapsedMs
    return {
      mode: this.mode,
      status: this.status,
      durationMs: this.durationMs,
      elapsedMs,
      remainingMs: Math.max(0, this.durationMs - elapsedMs),
      completedPomodoros: this.completedPomodoros,
      longRestSuggestion: false
    }
  }

  /** 开始新会话（重置本轮计时，保留番茄计数） */
  start(options: TimerOptions): TimerSnapshot {
    this.mode = options.mode
    this.durationMs = Math.max(
      1000,
      Number.isFinite(options.durationMs) ? options.durationMs : 25 * 60 * 1000
    )
    this.baseElapsedMs = 0
    this.status = 'running'
    this.runStartMs = TimerService.nowMs()
    this.ensureLoop()
    this.emit()
    return this.getSnapshot()
  }

  /**
   * 从持久化状态恢复会话（方案 2.5 防重启绕过）。
   * elapsedMs 为已计时长（单调时钟），剩余 = durationMs - elapsedMs。
   */
  restore(options: TimerOptions & { elapsedMs: number }): TimerSnapshot {
    this.mode = options.mode
    this.durationMs = Math.max(1000, options.durationMs)
    this.baseElapsedMs = Math.min(Math.max(0, options.elapsedMs), this.durationMs)
    this.status = 'running'
    this.runStartMs = TimerService.nowMs()
    this.ensureLoop()
    this.emit()
    return this.getSnapshot()
  }

  pause(): TimerSnapshot {
    if (this.status !== 'running') return this.getSnapshot()
    this.baseElapsedMs = this.getElapsedMs()
    this.status = 'paused'
    this.stopLoop()
    this.emit()
    return this.getSnapshot()
  }

  resume(): TimerSnapshot {
    if (this.status !== 'paused') return this.getSnapshot()
    this.status = 'running'
    this.runStartMs = TimerService.nowMs()
    this.ensureLoop()
    this.emit()
    return this.getSnapshot()
  }

  /**
   * 手动结束会话。
   * - countdown：未到点结束视为放弃（不计数）
   * - countup：正序计时手动结束视为完成一段（计数，无到点通知）
   */
  stop(): TimerSnapshot {
    this.stopLoop()
    if (this.status === 'running' || this.status === 'paused') {
      const elapsed = this.status === 'running' ? this.getElapsedMs() : this.baseElapsedMs
      if (this.mode === 'countup' && elapsed > 5000) {
        this.completePomodoro()
      }
      this.status = 'idle'
      this.baseElapsedMs = 0
      this.emit()
    } else if (this.status === 'finished') {
      this.status = 'idle'
      this.baseElapsedMs = 0
      this.emit()
    }
    return this.getSnapshot()
  }

  /** 逆序计时到点：完成 + 通知 */
  private finishCountdown(): void {
    this.stopLoop()
    this.baseElapsedMs = this.durationMs
    this.status = 'finished'
    const longRest = this.completePomodoro()
    this.emit()
    this.onComplete({ ...this.getSnapshot(), longRestSuggestion: longRest })
  }

  /** 计数一段番茄；满 4 归零并返回是否建议长休息 */
  private completePomodoro(): boolean {
    this.completedPomodoros += 1
    if (this.completedPomodoros >= 4) {
      this.completedPomodoros = 0
      return true
    }
    return false
  }

  private getElapsedMs(): number {
    return this.baseElapsedMs + (TimerService.nowMs() - this.runStartMs)
  }

  private ensureLoop(): void {
    if (this.interval) return
    this.interval = setInterval(() => {
      if (this.mode === 'countdown' && this.getSnapshot().remainingMs <= 0) {
        this.finishCountdown()
        return
      }
      this.emit()
    }, 1000)
  }

  private stopLoop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  /** 按秒去重推送，减少 IPC 洪泛 */
  private emit(): void {
    const snap = this.getSnapshot()
    const key = `${snap.status}|${snap.mode}|${Math.floor(snap.remainingMs / 1000)}|${Math.floor(snap.elapsedMs / 1000)}`
    if (key !== this.lastEmittedKey || snap.status === 'finished') {
      this.lastEmittedKey = key
      this.onTick(snap)
    }
  }
}
