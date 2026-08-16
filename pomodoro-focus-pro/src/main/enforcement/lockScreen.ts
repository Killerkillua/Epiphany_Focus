import { BrowserWindow } from 'electron'
import { spawn } from 'child_process'

/**
 * 锁定窗口形态（方案 2.5 L1/L2）：
 * - 全屏遮罩：setFullScreen + 置顶(screen-saver) + 禁缩放 + 隐藏任务栏 + 拦截关闭
 * - 到点动作"锁屏"：LockWorkStation（rundll32 user32.dll）
 */

let closeHandler: (() => void) | null = null

export function applyLevelWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.setFullScreen(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setResizable(false)
  win.setSkipTaskbar(true)
  // 拦截关闭：强制会话中无法直接关窗（Ctrl+W 已空处理，兜底此处）
  if (!closeHandler) {
    closeHandler = (): void => undefined
    win.on('close', closeHandler)
  }
}

export function releaseLevelWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (closeHandler) {
    win.removeListener('close', closeHandler)
    closeHandler = null
  }
  win.setResizable(true)
  win.setSkipTaskbar(false)
  win.setAlwaysOnTop(false)
  if (win.isFullScreen()) {
    win.setFullScreen(false)
  }
}

/** 到点动作：锁屏 */
export function lockWorkstation(): void {
  spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { stdio: 'ignore', windowsHide: true }).unref()
}
