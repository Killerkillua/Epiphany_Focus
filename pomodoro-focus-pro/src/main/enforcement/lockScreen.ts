import { BrowserWindow } from 'electron'
import { spawn } from 'child_process'

/**
 * 锁定窗口形态（方案 2.5 L1/L2）：
 * - 全屏遮罩：setFullScreen + 置顶(macOS) + 禁缩放 + 隐藏任务栏 + 拦截关闭
 * - 到点动作"锁屏"：LockWorkStation（rundll32 user32.dll）
 * - 按窗口引用计数：专注强制引擎与学习会话遮罩可能叠加在同一窗口上，
 *   各自 apply +1 / release -1，计数归零才真正还原窗口属性，避免互相解除。
 *
 * Windows 全屏遮罩修复（综合代码审查 + Electron 上游根因）：
 * - #8166 关键顺序：setFullScreen 必须发生在"仍可缩放"时。Electron 的 SetResizable(false)
 *   会把 min/max 钳制为当前尺寸（native_window_views.cc:866-888），先禁缩放再进全屏
 *   → 窗口无法放大、全屏完全不生效（表现为"非全屏"）。因此：进全屏 → 激活 → 置顶(macOS)
 *   → 最后禁缩放；释放时严格逆序：先恢复可缩放，再退出全屏。
 * - #38020 Windows 任务栏：置顶窗口与任务栏同为 topmost，z-order 竞争导致任务栏露出在
 *   遮罩之上；且 setAlwaysOnTop 的 level 参数在 Windows 未实现（#18933）。Windows 上
 *   遮罩不设置顶——前台全屏窗口本身盖住屏幕，shell 会为"前台全屏窗口"隐藏任务栏
 *   （B 站视频窗口不置顶，全屏一直正常，正是不置顶才正常）。跨应用压制由
 *   windowGuard 失焦拉回承担。
 * - 激活兜底：setFullScreen 后强制 show/focus/moveTop，复现"Alt+Tab 之后任务栏才隐藏"
 *   的效果（shell 只为前台全屏窗口隐藏任务栏）。
 * - P0-1 先显示再全屏：窗口未显示时推迟到 'show' 之后（未显示窗口直接全屏 → 显示异常）。
 * - P1-1 macOS 简单全屏兜底：setFullScreen 未生效时回退 setSimpleFullScreen（Windows 上
 *   两者是同一实现，无兜底意义，仅 macOS 保留）。
 * - P2-2 leave-full-screen / resize 事件兜底拉回：怎么退都退不出（count 归零才移除）。
 * - P2-1 全屏切换期间登记"过渡中"窗口（宽限期后自动清除），WindowGuard 的失焦拉回
 *   据此暂停，避免 show()+focus() 干扰系统全屏状态正确应用。
 */

/** macOS 简单全屏兜底校验延迟（ms）：setFullScreen 后仍非全屏则回退 */
const FULLSCREEN_FALLBACK_MS = 800
/** 全屏切换"过渡中"宽限期（ms）：进入/退出全屏期间暂停失焦拉回 */
const TRANSITION_GRACE_MS = 800

interface OverlayState {
  count: number
  closeHandler: ((event: Electron.Event) => void) | null
  /** P2-2：leave-full-screen / resize 兜底拉回处理器（count>0 时保持全屏） */
  assertFullscreen: (() => void) | null
  /** P1-1：setFullScreen 未生效时的简单全屏兜底定时器（仅 macOS） */
  fullscreenFallbackTimer: NodeJS.Timeout | null
  /** P1-1：当前窗口是否处于简单全屏（释放时需用 setSimpleFullScreen(false) 还原） */
  usingSimpleFullscreen: boolean
  /** 本次 apply 是否设置过置顶（Windows 不设置；释放时只还原自己设置的，避免清掉用户手动置顶） */
  usingAlwaysOnTop: boolean
  /** B 站视频窗口（跳过置顶）标记：兜底拉回复用同一进入序列时保持一致 */
  skipAlwaysOnTop: boolean
}

/** 各窗口的遮罩引用计数（key：BrowserWindow 实例） */
const overlayStates = new Map<BrowserWindow, OverlayState>()

/** P2-1：正在进入/退出全屏的窗口（宽限期后自动清除；WindowGuard 拉回前查询） */
const transitioningWindows = new Set<BrowserWindow>()

/** 标记窗口处于全屏切换过渡期（宽限期后自动清除，窗口销毁后残留无害） */
function markTransitioning(win: BrowserWindow): void {
  transitioningWindows.add(win)
  setTimeout(() => {
    transitioningWindows.delete(win)
  }, TRANSITION_GRACE_MS)
}

/** P2-1：窗口是否处于全屏切换过渡期（供 WindowGuard 失焦拉回暂停判定） */
export function isLevelWindowTransitioning(win: BrowserWindow | null): boolean {
  return win !== null && !win.isDestroyed() && transitioningWindows.has(win)
}

/** P1-1：setFullScreen 后校验，未生效则回退简单全屏（仅 macOS；Windows 上两者同一实现） */
function scheduleSimpleFullscreenFallback(win: BrowserWindow, state: OverlayState): void {
  if (process.platform !== 'darwin') return
  if (state.fullscreenFallbackTimer) clearTimeout(state.fullscreenFallbackTimer)
  state.fullscreenFallbackTimer = setTimeout(() => {
    state.fullscreenFallbackTimer = null
    if (win.isDestroyed() || state.count <= 0 || state.usingSimpleFullscreen) return
    if (win.isFullScreen()) return
    markTransitioning(win)
    state.usingSimpleFullscreen = true
    win.setSimpleFullScreen(true)
  }, FULLSCREEN_FALLBACK_MS)
}

/**
 * 进入全屏遮罩序列（apply 与 P2-2 兜底拉回共用）。
 * #8166 关键：必须仍可缩放时 setFullScreen(true)，之后再禁缩放（钳制为全屏尺寸）。
 * 已全屏时（如 B 站视频窗口由 attachFullscreenLock 先行全屏）跳过全屏调用，仅补齐其余属性。
 */
function enterOverlayFullscreen(win: BrowserWindow, state: OverlayState): void {
  if (win.isDestroyed()) return
  const wasFullscreen = win.isFullScreen()
  markTransitioning(win)
  if (!wasFullscreen) {
    win.setResizable(true) // #8166：解除可能存在的缩放钳制后再进全屏
    win.setFullScreen(true)
    // 激活兜底：shell 只为"前台全屏窗口"隐藏任务栏（等价于 Alt+Tab 之后的效果）
    if (!win.isFocused()) {
      win.show()
      win.focus()
    }
    win.moveTop()
  }
  // Windows 不设置顶（#38020：置顶与任务栏 z-order 竞争 → 任务栏露出）；macOS 保留
  if (!state.skipAlwaysOnTop && process.platform !== 'win32') {
    win.setAlwaysOnTop(true, 'screen-saver')
    state.usingAlwaysOnTop = true
  }
  // #8166：全屏成功后再禁缩放（钳制为全屏尺寸，防止拖拽缩放）
  win.setResizable(false)
  if (process.platform === 'darwin') scheduleSimpleFullscreenFallback(win, state)
}

export function applyLevelWindow(win: BrowserWindow, opts?: { skipAlwaysOnTop?: boolean }): void {
  if (win.isDestroyed()) return
  const state = overlayStates.get(win) ?? {
    count: 0,
    closeHandler: null,
    assertFullscreen: null,
    fullscreenFallbackTimer: null,
    usingSimpleFullscreen: false,
    usingAlwaysOnTop: false,
    skipAlwaysOnTop: opts?.skipAlwaysOnTop === true
  }
  state.count += 1
  if (state.count === 1) {
    // 任务栏按钮先于全屏隐藏（Windows；macOS 无任务栏按钮概念，无害）
    win.setSkipTaskbar(true)

    // P0-1：先显示再全屏（未显示窗口直接全屏 → Windows 显示异常 / 任务栏不覆盖）。
    // 最小化窗口 restore() 不触发 'show'，故同时监听 'show' 与 'restore'（先触发者生效，重复触发无害）
    if (win.isVisible() && !win.isMinimized()) {
      enterOverlayFullscreen(win, state)
    } else {
      if (win.isMinimized()) win.restore()
      const tryEnter = (): void => enterOverlayFullscreen(win, state)
      win.once('show', tryEnter)
      win.once('restore', tryEnter)
    }

    // 拦截关闭：强制会话中无法直接关窗（Ctrl+W 已空处理，兜底此处）
    state.closeHandler = (event: Electron.Event): void => {
      event.preventDefault()
    }
    win.on('close', state.closeHandler)

    // P2-2：leave-full-screen / resize 兜底拉回（与 fullscreenLock.ts 三重兜底对齐）。
    // 简单全屏不触发 leave-full-screen，且 isFullScreen() 恒为 false，故不参与拉回；
    // count 归零后移除监听，避免退出全屏时被自身拉回。
    state.assertFullscreen = (): void => {
      if (win.isDestroyed() || state.count <= 0) return
      if (state.usingSimpleFullscreen) return
      if (!win.isFullScreen()) {
        enterOverlayFullscreen(win, state)
      }
    }
    win.on('leave-full-screen', state.assertFullscreen)
    win.on('resize', state.assertFullscreen)

    // 窗口销毁后清理计数与定时器，避免 Map 泄漏
    win.once('closed', () => {
      overlayStates.delete(win)
      transitioningWindows.delete(win)
      if (state.fullscreenFallbackTimer) {
        clearTimeout(state.fullscreenFallbackTimer)
        state.fullscreenFallbackTimer = null
      }
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
  // P2-2：先移除兜底拉回，再退出全屏，避免退出过程中的 resize/leave 被拉回
  if (state.assertFullscreen) {
    win.removeListener('leave-full-screen', state.assertFullscreen)
    win.removeListener('resize', state.assertFullscreen)
    state.assertFullscreen = null
  }
  if (state.fullscreenFallbackTimer) {
    clearTimeout(state.fullscreenFallbackTimer)
    state.fullscreenFallbackTimer = null
  }

  // P2-1：标记过渡期，退出全屏瞬间的失焦不会触发 WindowGuard 拉回干扰还原
  markTransitioning(win)
  // P1-2 严格逆序释放（apply：skipTaskbar → fullscreen → [macOS 置顶] → 禁缩放）。
  // #8166：必须先恢复可缩放（解除 min/max 钳制），setFullScreen(false) 才能还原窗口尺寸。
  win.setResizable(true)
  if (state.usingAlwaysOnTop) {
    state.usingAlwaysOnTop = false
    win.setAlwaysOnTop(false)
  }
  if (state.usingSimpleFullscreen) {
    state.usingSimpleFullscreen = false
    win.setSimpleFullScreen(false)
  } else if (win.isFullScreen()) {
    win.setFullScreen(false)
  }
  win.setSkipTaskbar(false)
  overlayStates.delete(win)
}

/** 到点动作：锁屏 */
export function lockWorkstation(): void {
  spawn('rundll32.exe', ['user32.dll,LockWorkStation'], {
    stdio: 'ignore',
    windowsHide: true
  }).unref()
}
