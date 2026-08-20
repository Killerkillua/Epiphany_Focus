import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'node:path'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import { attachNavigationGuard, buildBlockPageHtml, isAllowedBiliUrl } from './guard'
import { attachFullscreenLock } from './fullscreenLock'
import { getSettings } from '../storage/settings'
import { recordTelemetry } from '../telemetry'
import type {
  BiliContext,
  BiliGuardContext,
  NavVerdict,
  OpenVideoPayload,
  OverlaySize,
  OverlaySnapshot,
  OverlayState,
  VideoState
} from '../../shared/bili'
import { OVERLAY_COLLAPSED_SIZE, OVERLAY_EXPANDED_SIZE, OVERLAY_STATES } from '../../shared/bili'

/**
 * B 站播放窗口管理（接入强制引擎 + 四层导航守卫 + 全屏锁定）：
 * - 视频窗口：加载 /video/BV*，挂载 L1–L4 导航守卫；全屏锁定防退出
 * - 悬浮面板窗口：无边框透明置顶窗口（全屏悬浮 AI 助手 + 记事本，可折叠），
 *   加载渲染层 #overlay 路由
 * - 强制会话：onOpen 启动 / onClose 结束
 */

/** 面板与视频窗口右缘的间距（px） */
const OVERLAY_GAP = 14

interface ActiveVideo {
  video: BrowserWindow
  overlay: BrowserWindow
  bvid: string
  autoFullscreen: boolean
}

interface VideoEventCallbacks {
  getMainWindow: () => BrowserWindow | null
  /** 打开视频时回调（启动强制会话 + 全屏锁定） */
  onOpen?: (video: BrowserWindow, payload: OpenVideoPayload) => void
  /** 关闭视频时回调（结束强制会话） */
  onClose?: () => void
}

let active: ActiveVideo | null = null
/** 主窗口获取器（用于把导航拦截等事件转发给渲染层；按需惰性取用） */
let getMainWindow: () => BrowserWindow | null = () => null
let currentTopic = ''
/** 当前视频标题（搜索结果页快照，导航守卫 L4 提取到更精确标题时更新；I-2 注入 AI 上下文） */
let currentVideoTitle = ''
let currentCtx: BiliGuardContext = { topic: '', strictness: 'standard', allowedBvs: [] }
/** 当前放行 BV 集合（渲染层可追加） */
let allowedBvs: string[] = []
/** 事件回调 */
let onOpenCallback: ((video: BrowserWindow, payload: OpenVideoPayload) => void) | undefined
let onCloseCallback: (() => void) | undefined

/* ===== 悬浮面板状态机（4 态：expanded / collapsed / minimized / hidden） ===== */
let overlayState: OverlayState = 'expanded'
/** 窗口能力（按锁定档解耦：L0/L1 可最小化 / L2 安全档全禁用） */
let overlayOptions: OverlayOptions = { allowMinimize: false, showInTaskbar: false }
/** 进入 hidden / minimized 前的可见态（呼出时恢复） */
let previousVisibleState: OverlayState = 'expanded'
/** 进入全屏时是否由我们自动折叠（离开全屏时恢复展开） */
let autoCollapsedOnFullscreen = false
/** 用户拖拽球体后的自定义位置（null = 未拖拽，跟随 dockOverlay 停靠） */
let ballPosition: { x: number; y: number } | null = null
/** 用户拖拽面板 header 后的自定义位置（null = 未拖拽，跟随 dockOverlay 停靠） */
let panelPosition: { x: number; y: number } | null = null
/** 全局呼出 / 关闭视频快捷键注册状态（供 getHotkeyStatus 上报 / 调试） */
let overlayHotkeyRegistered = false
let closeVideoHotkeyRegistered = false
/** 最近一次程序性 setPosition 的时间戳：'move' 事件在此窗口内视为程序移动，不记录为用户位置 */
let lastProgrammaticMoveAt = 0
/** 'move' 事件判为程序移动的时间窗口（ms），覆盖 setPosition 异步上报延迟 */
const MOVE_TRACKING_GUARD_MS = 150

interface OverlayOptions {
  allowMinimize: boolean
  showInTaskbar: boolean
}

/** 悬浮面板全局呼出快捷键（主键 Ctrl+Shift+O；Ctrl+` 尽力注册，部分输入法环境不可用） */
const OVERLAY_HOTKEYS = ['CommandOrControl+Shift+O', 'CommandOrControl+`'] as const

/** 一键关闭视频快捷键（全屏锁定下最直接的退出路径，任何面板状态下可用） */
const CLOSE_VIDEO_HOTKEY = 'CommandOrControl+Shift+Q'

/** 按锁定档解耦悬浮面板窗口能力（两态均可移动，不随锁定档限制） */
function buildOverlayOptions(): OverlayOptions {
  const level = getSettings().lockLevel
  return {
    allowMinimize: level !== 'L2',
    showInTaskbar: level === 'L0'
  }
}

export function registerVideoEvents(opts: VideoEventCallbacks): void {
  getMainWindow = opts.getMainWindow
  onOpenCallback = opts.onOpen
  onCloseCallback = opts.onClose
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function loadOverlay(win: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(`${devUrl}#overlay`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }
}

/** 程序性移动悬浮面板窗口（记录时间戳，'move' 事件据此不误判为用户拖拽） */
function setOverlayPosition(overlay: BrowserWindow, x: number, y: number): void {
  lastProgrammaticMoveAt = Date.now()
  overlay.setPosition(x, y)
}

/* ===== 停靠事件节流（P-3） =====
 * 视频窗口 move/resize/enter-full-screen/leave-full-screen 可能高频连续触发，
 * 每次直接 setPosition 会与视频渲染抢主进程 I/O。用 16ms 合并抖动窗口，
 * 一个事件窗口内只执行一次停靠。 */

let dockScheduled = false
function scheduleDock(): void {
  if (dockScheduled) return
  dockScheduled = true
  setTimeout(() => {
    dockScheduled = false
    dockOverlay()
  }, 16)
}

/** 把悬浮面板停靠在视频窗口右缘垂直居中（含全屏状态）；用户已自定义位置时保持原位 */
function dockOverlay(): void {
  if (!active) return
  const { video, overlay } = active
  if (overlay.isDestroyed()) return

  // 位置记忆：用户拖拽过 → 不跟随视频，保持用户放置的位置
  if (overlayState === 'collapsed' && ballPosition) return
  if (overlayState === 'expanded' && panelPosition) return

  const vb = video.getBounds()
  const ob = overlay.getBounds()
  const workArea = screen.getDisplayMatching(vb).workArea
  const x = Math.min(
    vb.x + vb.width - ob.width - OVERLAY_GAP,
    workArea.x + workArea.width - ob.width - OVERLAY_GAP
  )
  const y = Math.max(workArea.y + 12, vb.y + Math.max(0, (vb.height - ob.height) / 2))
  setOverlayPosition(overlay, Math.round(x), Math.round(y))
}

function createOverlay(video: BrowserWindow, opts: OverlayOptions): BrowserWindow {
  const overlay = new BrowserWindow({
    ...OVERLAY_EXPANDED_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true, // 始终允许：球态（渲染层指针拖拽）与面板态（header 原生拖拽）均可移动
    minimizable: opts.allowMinimize,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: !opts.showInTaskbar,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setMenuBarVisibility(false)
  loadOverlay(overlay)

  // 悬浮面板自身不应发生页面导航
  overlay.webContents.on('will-navigate', (event) => event.preventDefault())

  // 用户原生拖拽（展开态 header 标题栏）→ 记录自定义位置；
  // 程序性移动（dock / 状态恢复）在时间戳窗口内忽略，避免误判为"用户放置"
  overlay.on('move', () => {
    if (Date.now() - lastProgrammaticMoveAt < MOVE_TRACKING_GUARD_MS) return
    const b = overlay.getBounds()
    if (overlayState === 'collapsed') ballPosition = { x: b.x, y: b.y }
    else if (overlayState === 'expanded') panelPosition = { x: b.x, y: b.y }
  })

  overlay.once('ready-to-show', () => {
    dockOverlay()
    overlay.showInactive()
  })

  // 任务栏恢复（L0）时回到之前的可见态
  overlay.on('restore', () => {
    if (overlayState === 'minimized') {
      applyOverlayState(previousVisibleState === 'collapsed' ? 'collapsed' : 'expanded')
    }
    dockOverlay()
  })

  // 视频窗口移动 / 缩放 / 进出全屏时跟随停靠（节流合并，P-3；全屏状态协同见 fullscreenLock 回调）
  video.on('move', scheduleDock)
  video.on('resize', scheduleDock)
  video.on('enter-full-screen', scheduleDock)
  video.on('leave-full-screen', scheduleDock)

  return overlay
}

/** 构建守卫上下文（读取当前 settings 档位 + 会话放行集合） */
function buildGuardContext(topic: string, currentBvs: string[]): BiliGuardContext {
  const settings = getSettings()
  return {
    topic: topic ?? '',
    strictness: settings.bili.strictness ?? 'standard',
    allowedBvs: currentBvs ?? []
  }
}

/**
 * 打开视频播放窗口。
 * - autoFullscreen=true 时以全屏创建；接全屏锁定防退出
 * - 挂载四层导航守卫（L1–L4），命中拦截时加载提示页并通知主窗口渲染层
 * - 触发 onOpen 回调（启动强制会话）
 */
export function openVideo(payload: OpenVideoPayload): void {
  const { bvid, autoFullscreen, topic, title } = payload
  if (!bvid) throw new Error('缺少视频 BV 号')
  currentTopic = topic ?? ''
  currentVideoTitle = (title ?? '').trim()
  allowedBvs = [bvid]
  currentCtx = buildGuardContext(currentTopic, allowedBvs)

  // 幂等：先关闭旧窗口再开新窗口
  closeVideo()

  // 重置悬浮面板状态机（新会话从展开态开始）
  overlayState = 'expanded'
  previousVisibleState = 'expanded'
  autoCollapsedOnFullscreen = false
  overlayOptions = buildOverlayOptions()

  const video = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    fullscreen: autoFullscreen,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: `B 站学习 · ${bvid}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  video.setMenuBarVisibility(false)

  const handleBlocked = (verdict: NavVerdict): void => {
    recordTelemetry('bili', 'nav.blocked', { level: verdict.level ?? '' })
    sendToMainWindow(IPC_EVENTS.bili.navBlocked, verdict)
    if (!video.isDestroyed()) {
      video.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBlockPageHtml(verdict))}`).catch(() => {
        /* 忽略 */
      })
    }
  }

  const handleIrrelevant = (verdict: NavVerdict): void => {
    recordTelemetry('bili', 'nav.irrelevant', { level: verdict.level ?? '' })
    sendToMainWindow(IPC_EVENTS.bili.navBlocked, verdict)
  }

  attachNavigationGuard(video.webContents, currentCtx, {
    onBlocked: handleBlocked,
    onIrrelevant: handleIrrelevant,
    // L4 提取到更精确的视频标题 → 回填当前上下文（I-2：AI 可基于"正在看的这个视频"作答）
    onTitleExtracted: (extractedTitle) => {
      if (extractedTitle && extractedTitle.trim()) {
        currentVideoTitle = extractedTitle.trim()
      }
    }
  })

  // 全屏锁定（Esc/F11/缩小 均拉回）+ 全屏协同 Overlay 状态
  attachFullscreenLock(video, {
    autoFullscreen,
    active: () => !video.isDestroyed(),
    onEnterFullscreen: () => {
      // 展开态默认自动折叠为竖条（不挡视频）；用户手动展开后取消该默认
      if (!active || active.overlay.isDestroyed() || overlayState !== 'expanded') return
      autoCollapsedOnFullscreen = true
      applyOverlayState('collapsed')
    },
    onLeaveFullscreen: () => {
      if (autoCollapsedOnFullscreen) {
        autoCollapsedOnFullscreen = false
        applyOverlayState('expanded')
      }
    }
  })

  video.loadURL(`https://www.bilibili.com/video/${bvid}`).catch((err) => {
    sendToMainWindow(IPC_EVENTS.bili.navBlocked, {
      allowed: false,
      level: 'L1',
      category: '外部',
      reason: `视频页加载失败: ${err instanceof Error ? err.message : String(err)}`,
      url: `https://www.bilibili.com/video/${bvid}`,
      host: 'www.bilibili.com',
      path: `/video/${bvid}`
    } satisfies NavVerdict)
  })

  const overlay = createOverlay(video, overlayOptions)
  active = { video, overlay, bvid, autoFullscreen }

  // 全局呼出热键（会话期间生效）
  registerOverlayHotkey()

  video.once('ready-to-show', () => {
    video.show()
  })

  video.on('closed', () => {
    unregisterOverlayHotkey()
    if (!overlay.isDestroyed()) overlay.destroy()
    active = null
    currentVideoTitle = ''
    onCloseCallback?.()
    recordTelemetry('bili', 'video.close')
    sendToMainWindow(IPC_EVENTS.bili.videoClosed, { bvid })
  })

  // 触发 onOpen 回调（启动强制会话）
  onOpenCallback?.(video, payload)
  recordTelemetry('bili', 'video.open')

  sendToMainWindow(IPC_EVENTS.bili.videoOpened, {
    open: true,
    bvid,
    fullscreen: video.isFullScreen(),
    autoFullscreen
  } satisfies VideoState)
}

/** 关闭当前播放窗口（overlay 由 closed 事件级联销毁；重置位置记忆） */
export function closeVideo(): void {
  if (active && !active.video.isDestroyed()) {
    ballPosition = null
    panelPosition = null
    active.video.destroy()
  }
}

export function getVideoState(): VideoState {
  if (!active || active.video.isDestroyed()) {
    return { open: false, fullscreen: false, autoFullscreen: false }
  }
  return {
    open: true,
    bvid: active.bvid,
    fullscreen: active.video.isFullScreen(),
    autoFullscreen: active.autoFullscreen
  }
}

export function getContext(): BiliContext | null {
  if (!active || active.video.isDestroyed()) return null
  return {
    bvid: active.bvid,
    topic: currentTopic || undefined,
    videoTitle: currentVideoTitle || undefined,
    fullscreen: active.video.isFullScreen()
  }
}

/**
 * 时间点标记跳转（F-2）：让视频窗口 seek 到指定进度。
 * - 首选：标准 HTML5 `<video>` API（`currentTime`，非 B 站私有播放器接口，兼容改版）；
 * - 降级：`bvid?t=秒` 原生播放参数重载（更稳、符合导航守卫，/video/BV* 路径本就放行）。
 */
export async function seekTo(bvid: string, seconds: number): Promise<boolean> {
  if (!active || active.video.isDestroyed() || active.bvid !== bvid) return false
  const sec = Math.max(0, Math.round(seconds))
  try {
    const ok = (await active.video.webContents.executeJavaScript(
      `(() => {
        const v = document.querySelector('video')
        if (!v) return false
        v.currentTime = ${sec}
        return true
      })()`
    )) as boolean
    if (ok) {
      recordTelemetry('bili', 'seek', { seconds: sec })
      return true
    }
  } catch {
    /* 注入失败 → 走降级 */
  }
  const url = `https://www.bilibili.com/video/${bvid}?t=${sec}`
  active.video.loadURL(url).catch(() => {
    /* 忽略 */
  })
  return true
}

/** 读取视频当前播放位置（秒）：HTML5 video.currentTime（标准 API），失败返回 0 */
export async function getVideoPosition(): Promise<number> {
  if (!active || active.video.isDestroyed()) return 0
  try {
    const sec = (await active.video.webContents.executeJavaScript(
      `(() => {
        const v = document.querySelector('video')
        return v ? Math.floor(v.currentTime || 0) : 0
      })()`
    )) as number
    return typeof sec === 'number' && sec > 0 ? sec : 0
  } catch {
    return 0
  }
}

/** 当前会话的悬浮面板窗口（供强制引擎登记失焦拉回豁免等；无会话时返回 null） */
export function getOverlayWindow(): BrowserWindow | null {
  if (!active || active.overlay.isDestroyed()) return null
  return active.overlay
}

/**
 * 防御性提升悬浮面板置顶级别。
 * 在强制引擎对视频窗口施加全屏锁定（applyLevelWindow）之后调用，
 * 确保面板始终位于视频之上（视频窗口已跳过 screen-saver 置顶，此调用兜底同级 z-order 竞争）。
 */
export function ensureOverlayOnTop(): void {
  const overlay = getOverlayWindow()
  if (!overlay) return
  overlay.setAlwaysOnTop(true, 'screen-saver')
}

/** 悬浮面板折叠 / 展开时调整窗口尺寸并重新停靠（旧版兼容入口，新 UI 走 overlaySetState） */
export function resizeOverlay(size: OverlaySize): void {
  if (!active || active.overlay.isDestroyed()) return
  const width = Math.max(48, Math.round(size.width))
  const height = Math.max(48, Math.round(size.height))
  active.overlay.setSize(width, height)
  dockOverlay()
}

/**
 * 渲染层指针拖拽：按增量移动悬浮面板窗口（可移动悬浮球 / 可移动面板）。
 * 拖拽即用户放置 → 同步记录 ballPosition / panelPosition（位置记忆）。
 */
export function moveOverlayBy(dx: number, dy: number): void {
  const overlay = active?.overlay
  if (!overlay || overlay.isDestroyed()) return
  const [x, y] = overlay.getPosition()
  const nx = Math.round(x + dx)
  const ny = Math.round(y + dy)
  overlay.setPosition(nx, ny)
  // 直接记录（'move' 事件可能落在时间戳守卫窗口内被忽略，这里同步落盘用户位置）
  if (overlayState === 'collapsed') ballPosition = { x: nx, y: ny }
  else if (overlayState === 'expanded') panelPosition = { x: nx, y: ny }
}

/* ===== 悬浮面板状态机 API（4 态） ===== */

/** 广播状态快照给 overlay 与主窗口（外部事件驱动时同步渲染层 UI） */
function broadcastOverlayState(): void {
  const snapshot = getOverlaySnapshot()
  const overlay = active?.overlay
  if (overlay && !overlay.isDestroyed()) {
    overlay.webContents.send(IPC_EVENTS.bili.overlayStateChanged, snapshot)
  }
  sendToMainWindow(IPC_EVENTS.bili.overlayStateChanged, snapshot)
}

/** 内部应用状态：改尺寸 / 显隐 / 最小化，并广播快照 */
function applyOverlayState(next: OverlayState): void {
  const overlay = active?.overlay
  if (!overlay || overlay.isDestroyed()) return
  const prev = overlayState
  overlayState = next

  switch (next) {
    case 'expanded': {
      // 从球态展开：记住球的位置，恢复面板位置（面板态同样可移动）
      if (prev === 'collapsed') {
        const b = overlay.getBounds()
        ballPosition = { x: b.x, y: b.y }
      }
      autoCollapsedOnFullscreen = false
      overlay.setSize(OVERLAY_STATES.expanded.size.width, OVERLAY_STATES.expanded.size.height)
      overlay.setMovable(true)
      if (prev === 'minimized' && overlay.isMinimized()) overlay.restore()
      if (prev === 'hidden' || !overlay.isVisible()) overlay.showInactive()
      if (panelPosition) setOverlayPosition(overlay, panelPosition.x, panelPosition.y)
      else dockOverlay()
      break
    }
    case 'collapsed': {
      // 从面板态折叠：记住面板位置，恢复球的位置
      if (prev === 'expanded') {
        const b = overlay.getBounds()
        panelPosition = { x: b.x, y: b.y }
      }
      overlay.setSize(OVERLAY_STATES.collapsed.size.width, OVERLAY_STATES.collapsed.size.height)
      overlay.setMovable(true)
      if (prev === 'minimized' && overlay.isMinimized()) overlay.restore()
      if (prev === 'hidden' || !overlay.isVisible()) overlay.showInactive()
      if (ballPosition) setOverlayPosition(overlay, ballPosition.x, ballPosition.y)
      else dockOverlay()
      break
    }
    case 'minimized': {
      if (prev === 'expanded' || prev === 'collapsed') previousVisibleState = prev
      overlay.minimize()
      break
    }
    case 'hidden': {
      if (prev === 'expanded' || prev === 'collapsed') previousVisibleState = prev
      overlay.hide()
      break
    }
  }
  broadcastOverlayState()
}

/** 切换悬浮面板状态（渲染层按钮 / IPC 调用入口） */
export function setOverlayState(next: OverlayState): OverlaySnapshot {
  if (!active || active.overlay.isDestroyed()) {
    throw new Error('没有正在播放的视频，悬浮面板不可用')
  }
  if (next === 'minimized' && !overlayOptions.allowMinimize) {
    // L2 安全档不允许最小化：降级为隐藏并提示用户
    applyOverlayState('hidden')
    recordTelemetry('bili', 'overlay.state', { state: 'hidden' })
    return {
      ...getOverlaySnapshot(),
      notice: '当前锁定等级 L2 不允许最小化学习助手，已自动隐藏面板（Ctrl+Shift+O 呼出）'
    }
  }
  applyOverlayState(next)
  recordTelemetry('bili', 'overlay.state', { state: next })
  return getOverlaySnapshot()
}

/** 获取悬浮面板当前状态快照 */
export function getOverlaySnapshot(): OverlaySnapshot {
  if (!active || active.overlay.isDestroyed()) {
    return { state: 'hidden', size: OVERLAY_EXPANDED_SIZE, canMinimize: false }
  }
  return {
    state: overlayState,
    size: OVERLAY_STATES[overlayState].size,
    canMinimize: overlayOptions.allowMinimize
  }
}

/** 隐藏 ⇄ 呼出（全局热键回调 / IPC 入口）：呼出时恢复进入隐藏前的可见态 */
export function toggleOverlayHide(): OverlaySnapshot {
  if (!active || active.overlay.isDestroyed()) {
    throw new Error('没有正在播放的视频，悬浮面板不可用')
  }
  if (overlayState === 'hidden') {
    applyOverlayState(previousVisibleState === 'collapsed' ? 'collapsed' : 'expanded')
  } else {
    applyOverlayState('hidden')
  }
  return getOverlaySnapshot()
}

/* ===== 全局呼出热键（会话期间注册，退出注销） ===== */

function registerOverlayHotkey(): void {
  // 必须检查 globalShortcut.register() 返回值：被占用时返回 false 而不抛异常，
  // 若不检查会把"注册失败"静默吞掉，导致快捷键按下无任何效果（参照 audio/index.ts）
  overlayHotkeyRegistered = false
  for (const acc of OVERLAY_HOTKEYS) {
    try {
      const ok = globalShortcut.register(acc, () => {
        try {
          toggleOverlayHide()
        } catch {
          /* 会话已结束，忽略 */
        }
      })
      if (ok) overlayHotkeyRegistered = true
      else console.warn(`[bili] 热键注册失败（可能被占用）: ${acc}（面板显隐）`)
    } catch {
      // Ctrl+` 在部分输入法 / 系统下不可注册，忽略（Ctrl+Shift+O 为主键）
    }
  }
  // 关闭视频：全屏学习时的兜底退出路径（Ctrl+Shift+Q，注册失败时仍可走面板按钮退出）
  closeVideoHotkeyRegistered = false
  try {
    const ok = globalShortcut.register(CLOSE_VIDEO_HOTKEY, () => closeVideo())
    if (ok) closeVideoHotkeyRegistered = true
    else console.warn(`[bili] 热键注册失败（可能被占用）: ${CLOSE_VIDEO_HOTKEY}（关闭视频）`)
  } catch {
    /* 忽略 */
  }
}

/** 快捷键注册状态（调试 / 未来 UI 提示用） */
export function getHotkeyStatus(): { overlay: boolean; closeVideo: boolean } {
  return { overlay: overlayHotkeyRegistered, closeVideo: closeVideoHotkeyRegistered }
}

function unregisterOverlayHotkey(): void {
  overlayHotkeyRegistered = false
  closeVideoHotkeyRegistered = false
  for (const acc of OVERLAY_HOTKEYS) {
    try {
      globalShortcut.unregister(acc)
    } catch {
      /* 忽略 */
    }
  }
  try {
    globalShortcut.unregister(CLOSE_VIDEO_HOTKEY)
  } catch {
    /* 忽略 */
  }
}

/** 把 BV 加入当前会话放行集合（渲染层"标记为相关"调用） */
export function markRelevant(bvid: string): boolean {
  if (!bvid) return false
  if (!allowedBvs.includes(bvid)) {
    allowedBvs.push(bvid)
  }
  currentCtx = buildGuardContext(currentTopic, allowedBvs)
  return true
}

/** 供调试 / 测试使用：暴露纯判定函数 */
export { isAllowedBiliUrl }

export const OVERLAY_SIZES = { expanded: OVERLAY_EXPANDED_SIZE, collapsed: OVERLAY_COLLAPSED_SIZE }