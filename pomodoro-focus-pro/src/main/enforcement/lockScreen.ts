import { BrowserWindow } from 'electron'
import { spawn } from 'child_process'

/**
 * 锁定窗口形态（方案 2.5 L1/L2）：
 * - 全屏遮罩：setFullScreen + 置顶(screen-saver) + 禁缩放 + 隐藏任务栏 + 拦截关闭
 * - 到点动作"锁屏"：LockWorkStation（rundll32 user32.dll）
 * - 按窗口引用计数：专注强制引擎与学习会话遮罩可能叠加在同一窗口上，
 *   各自 apply +1 / release -1，计数归零才真正还原窗口属性，避免互相解除。
 */

interface OverlayState {
  count: number
  closeHandler: ((event: Electron.Event) => void) | null
}

/** 各窗口的遮罩引用计数（key：BrowserWindow 实例） */
const overlayStates = new Map<BrowserWindow, OverlayState>()

export function applyLevelWindow(win: BrowserWindow, opts?: { skipAlwaysOnTop?: boolean }): void {
  if (win.isDestroyed()) return
  const state = overlayStates.get(win) ?? { count: 0, closeHandler: null }
  state.count += 1
  if (state.count === 1) {
    win.setFullScreen(true)
    // B 站模式跳过置顶：悬浮面板（screen-saver 置顶）必须始终浮于视频之上，
    // 若视频窗口也设为同级置顶（且后调用），Windows 上会覆盖悬浮面板/悬浮球
    if (!opts?.skipAlwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
    win.setResizable(false)
    win.setSkipTaskbar(true)
    // 拦截关闭：强制会话中无法直接关窗（Ctrl+W 已空处理，兜底此处）
    state.closeHandler = (event: Electron.Event): void => {
      event.preventDefault()
    }
    win.on('close', state.closeHandler)
    // 窗口销毁后清理计数，避免 Map 泄漏
    win.once('closed', () => {
      overlayStates.delete(win)
    })
  }
  overlayStates.set(win, state)
}

export function releaseLevelWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const state = overlayStates.get(win)
  if (!state) return
  state.count = Math.max(0, state.count - 1)
  if (state.count > 0) {
    overlayStates.set(win, state)
    return
  }
  if (state.closeHandler) {
    win.removeListener('close', state.closeHandler)
    state.closeHandler = null
  }
  win.setResizable(true)
  win.setSkipTaskbar(false)
  win.setAlwaysOnTop(false)
  if (win.isFullScreen()) {
    win.setFullScreen(false)
  }
  overlayStates.delete(win)
}

/** 到点动作：锁屏 */
export function lockWorkstation(): void {
  spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { stdio: 'ignore', windowsHide: true }).unref()
}
