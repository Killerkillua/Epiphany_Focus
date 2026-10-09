import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'node:path'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
import { attachNavigationGuard, buildBlockPageHtml, isAllowedBiliUrl } from './guard'
import { attachFullscreenLock } from './fullscreenLock'
import { attachLocalPlayerGuard, attachSiteNavigationGuard } from '../study/siteGuard'
import { getLearningWebSession } from '../study/learningSession'
import { revokeMediaToken } from '../study/localMediaStore'
import { biliResourceKey, type StudyResourceKind } from '../../shared/study'
import { getAppIcon } from '../icon'
import { reinforceTaskbarCover } from '../enforcement/taskbarWin'
import { getSettings } from '../storage/settings'
import { recordStudySessionEnd, recordStudySessionStart } from '../storage/db'
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
import { OVERLAY_EXPANDED_SIZE, OVERLAY_STATES } from '../../shared/bili'

/**
 * 视频学习播放窗口管理（接入强制引擎 + 四层导航守卫 + 全屏锁定）：
 * - 视频窗口：加载 /video/BV*，挂载 L1–L4 导航守卫；全屏锁定防退出
 * - 悬浮面板窗口：无边框透明置顶窗口（全屏悬浮 AI 助手 + 记事本，展开态 610×940，
 *   可拖拽 header 移动 / 最小化，最小窗口 610×940），加载渲染层 #overlay 路由
 * - 强制会话：onOpen 启动 / onClose 结束
 */

/** 面板与视频窗口右缘的间距（px） */
const OVERLAY_GAP = 14

interface ActiveVideo {
  video: BrowserWindow
  overlay: BrowserWindow
  bvid: string
  resourceKey: string
  kind: StudyResourceKind
  autoFullscreen: boolean
  mediaToken?: string
}

export interface PlaybackMeta {
  resourceKey: string
  resourceType: StudyResourceKind
  /** 仅主进程使用。本地为绝对路径，网站为规范化 URL，B 站为空 */
  sourceUri: string
}

export interface LearningContentLaunch {
  kind: 'local' | 'web'
  resourceKey: string
  recordId: string
  title: string
  topic?: string
  autoFullscreen: boolean
  plannedMs?: number
  seekSeconds?: number
  source?: OpenVideoPayload['source']
  author?: string
  coverUrl?: string
  url?: string
  mediaToken?: string
  sourceUri: string
}

let pendingLaunch: LearningContentLaunch | null = null
let playbackMeta: PlaybackMeta = { resourceKey: '', resourceType: 'bili', sourceUri: '' }

export function getPlaybackMeta(): PlaybackMeta {
  return playbackMeta
}

interface VideoEventCallbacks {
  getMainWindow: () => BrowserWindow | null
  /** 创建视频窗口之前回调（P-2：前置释放主窗口学习会话遮罩，避免 screen-saver 置顶遮罩盖住视频窗口） */
  onBeforeOpen?: () => void
  /** 打开视频时回调（启动强制会话 + 全屏锁定） */
  onOpen?: (video: BrowserWindow, payload: OpenVideoPayload) => void
  /** 关闭视频时回调（结束强制会话） */
  onClose?: () => void
  /** 主进程兜底 5×Esc 命中回调（P-2：唤起主窗口紧急退出弹窗） */
  onEscapeSpam?: () => void
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
let onBeforeOpenCallback: (() => void) | undefined
let onOpenCallback: ((video: BrowserWindow, payload: OpenVideoPayload) => void) | undefined
let onCloseCallback: (() => void) | undefined
let onEscapeSpamCallback: (() => void) | undefined

/* ===== 悬浮面板状态机（3 态：expanded / minimized / hidden，已删除 collapsed 悬浮球） ===== */
let overlayState: OverlayState = 'expanded'
/** 窗口能力（按锁定档解耦：L0/L1 可最小化 / L2 安全档全禁用） */
let overlayOptions: OverlayOptions = { allowMinimize: false, showInTaskbar: false }
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
  onBeforeOpenCallback = opts.onBeforeOpen
  onOpenCallback = opts.onOpen
  onCloseCallback = opts.onClose
  onEscapeSpamCallback = opts.onEscapeSpam
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
  const appIcon = getAppIcon()
  const overlay = new BrowserWindow({
    ...OVERLAY_EXPANDED_SIZE, // 610×940（学习助手重构：始终展开态）
    minWidth: OVERLAY_EXPANDED_SIZE.width,
    minHeight: OVERLAY_EXPANDED_SIZE.height,
    frame: false,
    transparent: true,
    resizable: true, // 允许系统级缩放（配合 setMinimumSize 约束最小 610×940）
    movable: true, // 始终允许：展开态 header 原生拖拽移动
    minimizable: opts.allowMinimize,
    maximizable: false,
    // Windows 上任意置顶都是 HWND_TOPMOST，会和任务栏抢 z-order，前台全屏窗口因此藏不住任务栏。
    // 改成学习窗口的拥有窗口：仍浮在网页之上，但不再把任务栏顶出来。
    alwaysOnTop: process.platform !== 'win32',
    parent: process.platform === 'win32' ? video : undefined,
    skipTaskbar: !opts.showInTaskbar,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 悬浮面板不应开新窗口
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  overlay.setMinimumSize(OVERLAY_EXPANDED_SIZE.width, OVERLAY_EXPANDED_SIZE.height)
  if (process.platform !== 'win32') overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setMenuBarVisibility(false)
  loadOverlay(overlay)

  // 悬浮面板自身不应发生页面导航
  overlay.webContents.on('will-navigate', (event) => event.preventDefault())

  // 用户原生拖拽（展开态 header 标题栏）→ 记录自定义位置；
  // 程序性移动（dock / 状态恢复）在时间戳窗口内忽略，避免误判为"用户放置"
  overlay.on('move', () => {
    if (Date.now() - lastProgrammaticMoveAt < MOVE_TRACKING_GUARD_MS) return
    const b = overlay.getBounds()
    if (overlayState === 'expanded') panelPosition = { x: b.x, y: b.y }
  })

  overlay.once('ready-to-show', () => {
    dockOverlay()
    overlay.showInactive()
    reinforceTaskbarCover()
  })

  // 任务栏恢复（L0）时回到展开态
  overlay.on('restore', () => {
    if (overlayState === 'minimized') {
      applyOverlayState('expanded')
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
export function openLearningContent(launch: LearningContentLaunch): void {
  pendingLaunch = launch
  try {
    openVideo({
      bvid: launch.recordId,
      autoFullscreen: launch.autoFullscreen,
      title: launch.title,
      topic: launch.topic,
      plannedMs: launch.plannedMs,
      seekSeconds: launch.seekSeconds,
      source: launch.source,
      author: launch.author,
      coverUrl: launch.coverUrl
    })
  } catch (err) {
    pendingLaunch = null
    throw err
  }
}

function loadLocalPlayer(
  video: BrowserWindow,
  token: string,
  extension: string,
  seekSeconds?: number
): void {
  const start = seekSeconds && seekSeconds > 0 ? `&t=${Math.round(seekSeconds)}` : ''
  const hash = `local-player?token=${encodeURIComponent(token)}&ext=${encodeURIComponent(extension)}${start}`
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    video.loadURL(`${devUrl}#${hash}`).catch(() => {
      /* 忽略 */
    })
    return
  }
  video.loadFile(join(__dirname, '../renderer/index.html'), { hash }).catch(() => {
    /* 忽略 */
  })
}

export function openVideo(payload: OpenVideoPayload): void {
  const launch = pendingLaunch
  pendingLaunch = null
  const {
    bvid,
    autoFullscreen,
    topic,
    title,
    seekSeconds,
    source = 'manual',
    coverUrl,
    author
  } = payload
  if (!bvid) throw new Error('缺少视频 BV 号')
  const kind: StudyResourceKind = launch?.kind ?? 'bili'
  const resourceKey = launch?.resourceKey ?? biliResourceKey(bvid)
  playbackMeta = {
    resourceKey,
    resourceType: kind,
    sourceUri: launch?.sourceUri ?? ''
  }
  currentTopic = topic ?? ''
  currentVideoTitle = (title ?? '').trim()
  allowedBvs = kind === 'bili' ? [bvid] : []
  currentCtx = buildGuardContext(currentTopic, allowedBvs)

  // 幂等：先关闭旧窗口再开新窗口
  closeVideo()

  // P-2：创建视频窗口之前前置释放主窗口学习会话遮罩（screen-saver 置顶遮罩会盖住未置顶的视频窗口）
  onBeforeOpenCallback?.()

  // 重置悬浮面板状态机（新会话从展开态开始）
  overlayState = 'expanded'
  overlayOptions = buildOverlayOptions()

  // M3：本次打开的视频窗口构成一个学习会话（关闭时结算时长）；来源写入 study_sessions.source
  const studySessionId = recordStudySessionStart(bvid, source)

  const appIcon = getAppIcon()
  const video = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false, // P-2：先创建后显示（创建后立即 show()，再 setFullScreen），规避 Windows "先全屏后显示" 显示异常
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: title?.trim() || `视频学习 · ${bvid}`,
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences:
      kind === 'local'
        ? {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        : {
            contextIsolation: true,
            nodeIntegration: false,
            // 第三方页面无 preload，必须沙箱化；网站使用独立登录分区
            sandbox: true,
            ...(kind === 'web' ? { session: getLearningWebSession() } : {})
          }
  })
  video.setMenuBarVisibility(false)

  const handleBlocked = (verdict: NavVerdict): void => {
    recordTelemetry('bili', 'nav.blocked', { level: verdict.level ?? '' })
    sendToMainWindow(IPC_EVENTS.bili.navBlocked, verdict)
    if (!video.isDestroyed()) {
      video
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBlockPageHtml(verdict))}`)
        .catch(() => {
          /* 忽略 */
        })
    }
  }

  const handleIrrelevant = (verdict: NavVerdict): void => {
    recordTelemetry('bili', 'nav.irrelevant', { level: verdict.level ?? '' })
    sendToMainWindow(IPC_EVENTS.bili.navBlocked, verdict)
  }

  if (kind === 'bili') {
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
  } else if (kind === 'web') {
    attachSiteNavigationGuard(video.webContents, () => getSettings().learning.sites, {
      onBlocked: handleBlocked,
      onTitle: (extractedTitle) => {
        if (extractedTitle.trim()) currentVideoTitle = extractedTitle.trim()
      }
    })
  } else {
    attachLocalPlayerGuard(video.webContents)
  }

  // 全屏锁定（Esc/F11/缩小 均拉回）。已删除"进入全屏自动折叠为悬浮球"的协同：
  // 学习助手重构后始终以展开态呈现，进出全屏由 dockOverlay 跟随停靠。
  // P-2：autoFullscreen 延迟到窗口显示后 setFullScreen；主进程兜底 5×Esc → 唤起紧急退出弹窗。
  attachFullscreenLock(video, {
    autoFullscreen,
    active: () => !video.isDestroyed(),
    onEscapeSpam: () => onEscapeSpamCallback?.()
  })

  // P-2：创建后立即显示（不等 ready-to-show：页面加载失败 / 需登录时窗口也不至于"永不显示"）
  video.show()

  if (kind === 'local' && launch?.mediaToken) {
    const extension = launch.sourceUri ? launch.sourceUri.slice(launch.sourceUri.lastIndexOf('.')) : ''
    loadLocalPlayer(video, launch.mediaToken, extension, seekSeconds)
  } else if (kind === 'web' && launch?.url) {
    video.loadURL(launch.url).catch((err) => {
      sendToMainWindow(IPC_EVENTS.bili.navBlocked, {
        allowed: false,
        level: 'L1',
        category: '外部',
        reason: `学习网站加载失败: ${err instanceof Error ? err.message : String(err)}`,
        url: launch.url ?? '',
        host: '',
        path: ''
      } satisfies NavVerdict)
    })
  } else {
    // M2 续学：seekSeconds > 0 时用视频学习原生 ?t= 参数加载，播放器就绪即定位到上次位置
    const videoUrl =
      seekSeconds && seekSeconds > 0
        ? `https://www.bilibili.com/video/${bvid}?t=${Math.max(0, Math.round(seekSeconds))}`
        : `https://www.bilibili.com/video/${bvid}`
    video.loadURL(videoUrl).catch((err) => {
      sendToMainWindow(IPC_EVENTS.bili.navBlocked, {
        allowed: false,
        level: 'L1',
        category: '外部',
        reason: `视频页加载失败: ${err instanceof Error ? err.message : String(err)}`,
        url: videoUrl,
        host: 'www.bilibili.com',
        path: `/video/${bvid}`
      } satisfies NavVerdict)
    })
  }

  const overlay = createOverlay(video, overlayOptions)
  active = {
    video,
    overlay,
    bvid,
    resourceKey,
    kind,
    autoFullscreen,
    mediaToken: launch?.mediaToken
  }

  // 全局呼出热键（会话期间生效）
  registerOverlayHotkey()

  video.on('closed', () => {
    unregisterOverlayHotkey()
    if (active?.mediaToken) revokeMediaToken(active.mediaToken)
    if (!overlay.isDestroyed()) overlay.destroy()
    active = null
    currentVideoTitle = ''
    // M3：会话结束（幂等，duration_s = 打开窗口的墙钟时长）
    if (studySessionId) recordStudySessionEnd(studySessionId)
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
    resourceKey: active.resourceKey,
    resourceKind: active.kind,
    topic: currentTopic || undefined,
    videoTitle: currentVideoTitle || undefined,
    fullscreen: active.video.isFullScreen()
  }
}

/**
 * 时间点标记跳转（F-2）：让视频窗口 seek 到指定进度。
 * - 首选：标准 HTML5 `<video>` API（`currentTime`，非 视频学习私有播放器接口，兼容改版）；
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
  if (active.kind !== 'bili') return false
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

/** 读取视频总时长（秒）：HTML5 video.duration（标准 API），未就绪 / 失败返回 0 */
export async function getVideoDuration(): Promise<number> {
  if (!active || active.video.isDestroyed()) return 0
  try {
    const sec = (await active.video.webContents.executeJavaScript(
      `(() => {
        const v = document.querySelector('video')
        return v && Number.isFinite(v.duration) ? Math.floor(v.duration) : 0
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
  // Windows 靠 parent 保持在学习窗口之上；再 setAlwaysOnTop 会把任务栏顶出来
  if (process.platform === 'win32') return
  overlay.setAlwaysOnTop(true, 'screen-saver')
}

/** 悬浮面板调整窗口尺寸并重新停靠（兼容入口；最小尺寸钳制到 610×940） */
export function resizeOverlay(size: OverlaySize): void {
  if (!active || active.overlay.isDestroyed()) return
  // 数值校验：非法（NaN / 非有限数 / 缺字段）尺寸直接忽略，避免 Math.round→setSize 崩溃或窗口异常
  const w = Number(size?.width)
  const h = Number(size?.height)
  if (!Number.isFinite(w) || !Number.isFinite(h)) return
  const width = Math.max(OVERLAY_EXPANDED_SIZE.width, Math.round(w))
  const height = Math.max(OVERLAY_EXPANDED_SIZE.height, Math.round(h))
  active.overlay.setSize(width, height)
  dockOverlay()
}

/* ===== 悬浮面板状态机 API（3 态） ===== */

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
      overlay.setSize(OVERLAY_STATES.expanded.size.width, OVERLAY_STATES.expanded.size.height)
      overlay.setMovable(true)
      if (prev === 'minimized' && overlay.isMinimized()) overlay.restore()
      if (prev === 'hidden' || !overlay.isVisible()) overlay.showInactive()
      reinforceTaskbarCover()
      if (panelPosition) setOverlayPosition(overlay, panelPosition.x, panelPosition.y)
      else dockOverlay()
      break
    }
    case 'minimized': {
      overlay.minimize()
      break
    }
    case 'hidden': {
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
    // 学习助手重构后无悬浮球态：呼出固定恢复展开态
    applyOverlayState('expanded')
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

export const OVERLAY_SIZES = { expanded: OVERLAY_EXPANDED_SIZE }
