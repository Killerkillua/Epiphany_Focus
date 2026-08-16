import type { BrowserWindow } from 'electron'

/**
 * B 站全屏锁定守卫。
 * 核心思路：不全局拦截 Esc（需留给渲染层"连按 5 次 Esc"紧急退出），
 * 而是用 leave-full-screen / exit-full-screen / resize 三个事件兜底拉回，
 * 形成"怎么退都退不出"的效果。
 * F11 / Ctrl+W/T/R/F5 已由 shortcutGuard 全局消费。
 */

export interface FullscreenLockOpts {
  autoFullscreen: boolean
  /** 是否仍处于强制会话（结束时置 false 解除锁定） */
  active: () => boolean
  /** 视频进入全屏时的回调（biliWindow 协同悬浮面板状态） */
  onEnterFullscreen?: () => void
  /** 视频离开全屏时的回调（biliWindow 协同悬浮面板状态） */
  onLeaveFullscreen?: () => void
}

export function attachFullscreenLock(win: BrowserWindow, opts: FullscreenLockOpts): void {
  if (opts.autoFullscreen) win.setFullScreen(true)

  const assertFullscreen = (): void => {
    if (opts.active() && !win.isFullScreen()) {
      win.setFullScreen(true)   // 兜底拉回：Esc / 缩小 / F11 之后立即恢复
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

  // 可选加固：在渲染层消费 Escape 键，避免触发一次"退出→拉回"的闪烁
  win.webContents.on('before-input-event', (_e, input) => {
    if (opts.active() && input.key === 'Escape') _e.preventDefault()
  })
}