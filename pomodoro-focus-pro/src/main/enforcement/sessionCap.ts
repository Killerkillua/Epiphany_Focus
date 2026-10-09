import { isSessionExpired, msUntilSessionExpiry } from './emergencyExit'

/**
 * 会话墙钟上限监视。
 * 应用保持打开时，到点解除锁定；不依赖番茄倒计时（正序计时不会自己到点，暂停会冻住单调时钟）。
 */
export interface SessionCapWatch {
  arm(startedAt: number): void
  clear(): void
}

export function createSessionCapWatch(onExpire: () => void): SessionCapWatch {
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function arm(startedAt: number): void {
    clear()
    timer = setTimeout(() => {
      timer = null
      // 系统时间被拨回时重新排队，而不是提前解锁
      if (!isSessionExpired(startedAt)) {
        arm(startedAt)
        return
      }
      onExpire()
    }, msUntilSessionExpiry(startedAt))
  }

  return { arm, clear }
}
