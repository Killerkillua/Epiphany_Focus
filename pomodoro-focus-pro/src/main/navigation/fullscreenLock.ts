import type { BrowserWindow } from 'electron'

/**
 * 视频学习全屏锁定守卫。
 * 核心思路：不全局拦截 Esc（需留给紧急退出），
 * 而是用 leave-full-screen / exit-full-screen / resize 三个事件兜底拉回，
 * 形成"怎么退都退不出"的效果。
 * F11 / Ctrl+W/T/R/F5 已由 shortcutGuard 全局消费。
 *
 * 问题 2 修复（P-2）：
 * 1. 先显示再全屏：autoFullscreen 延迟到窗口 'show' 之后 setFullScreen(true)，
 *    规避 Windows 上"先全屏后显示"导致视频窗口黑屏/不显示的显示异常。
 * 2. Escape 放行：视频窗口聚焦时主窗口渲染层收不到 Esc，"连按 5 次 Esc"紧急退出
 *    无法触发。此处由主进程在视频窗口侧兜底检测 5×Esc（3 秒窗口），
 *    命中后回调 onEscapeSpam 唤起主窗口紧急退出弹窗，保证紧急退出始终可达。
 */

const ESC_COUNT = 5
const ESC_WINDOW_MS = 3000

export interface FullscreenLockOpts {
  autoFullscreen: boolean
  /** 是否仍处于强制会话（结束时置 false 解除锁定） */
  active: () => boolean
  /** 视频进入全屏时的回调（biliWindow 协同悬浮面板状态） */
  onEnterFullscreen?: () => void
  /** 视频离开全屏时的回调（biliWindow 协同悬浮面板状态） */
  onLeaveFullscreen?: () => void
  /** 主进程兜底 5×Esc（3 秒窗口）命中回调（唤起主窗口紧急退出弹窗） */
  onEscapeSpam?: () => void
}

export function attachFullscreenLock(win: BrowserWindow, opts: FullscreenLockOpts): void {
  if (opts.autoFullscreen) {
    // 先显示再全屏：规避 Windows "先全屏后显示" 的显示异常（P-2 根因）
    const applyFullscreen = (): void => {
      if (!win.isDestroyed() && opts.active() && !win.isFullScreen()) {
        win.setFullScreen(true)
      }
    }
    if (win.isVisible()) applyFullscreen()
    else win.once('show', applyFullscreen)
  }

  const assertFullscreen = (): void => {
    if (opts.active() && !win.isFullScreen()) {
      win.setFullScreen(true) // 兜底拉回：Esc / 缩小 / F11 之后立即恢复
    }
  }
  win.on('enter-full-screen', () => {
    opts.onEnterFullscreen?.()
  })
  win.on('leave-full-screen', () => {
    opts.onLeaveFullscreen?.()
    assertFullscreen()
  })
  win.on('resize', assertFullscreen)

  // 5×Esc（3 秒窗口）主进程兜底检测：视频窗口聚焦时主窗口渲染层收不到 Esc，
  // 渲染层"连按 5 次 Esc"检测失效；此处命中后放行给紧急退出流程接管。
  let escTimes: number[] = []
  win.webContents.on('before-input-event', (_e, input) => {
    if (!opts.active() || input.key !== 'Escape') return
    const now = Date.now()
    escTimes = [...escTimes.filter((t) => now - t < ESC_WINDOW_MS), now]
    if (escTimes.length >= ESC_COUNT) {
      escTimes = []
      opts.onEscapeSpam?.()
    }
    // 仍消费单次 Esc：防止 视频学习播放器退全屏触发"退出→拉回"闪烁
    _e.preventDefault()
  })
}
