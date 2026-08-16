import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import { attachNavigationGuard, buildBlockPageHtml, isAllowedBiliUrl } from './guard'
import { attachFullscreenLock } from './fullscreenLock'
import { getSettings } from '../storage/settings'
import type {
  BiliContext,
  BiliGuardContext,
  NavVerdict,
  OpenVideoPayload,
  OverlaySize,
  VideoState
} from '../../shared/bili'
import { OVERLAY_COLLAPSED_SIZE, OVERLAY_EXPANDED_SIZE } from '../../shared/bili'

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
let currentCtx: BiliGuardContext = { topic: '', strictness: 'standard', allowedBvs: [] }
/** 当前放行 BV 集合（渲染层可追加） */
let allowedBvs: string[] = []
/** 事件回调 */
let onOpenCallback: ((video: BrowserWindow, payload: OpenVideoPayload) => void) | undefined
let onCloseCallback: (() => void) | undefined

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

/** 把悬浮面板停靠在视频窗口右缘垂直居中（含全屏状态） */
function dockOverlay(): void {
  if (!active) return
  const { video, overlay } = active
  if (overlay.isDestroyed()) return
  const vb = video.getBounds()
  const ob = overlay.getBounds()
  const workArea = screen.getDisplayMatching(vb).workArea
  const x = Math.min(
    vb.x + vb.width - ob.width - OVERLAY_GAP,
    workArea.x + workArea.width - ob.width - OVERLAY_GAP
  )
  const y = Math.max(workArea.y + 12, vb.y + Math.max(0, (vb.height - ob.height) / 2))
  overlay.setPosition(Math.round(x), Math.round(y))
}

function createOverlay(video: BrowserWindow): BrowserWindow {
  const overlay = new BrowserWindow({
    ...OVERLAY_EXPANDED_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
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

  overlay.once('ready-to-show', () => {
    dockOverlay()
    overlay.showInactive()
  })

  // 视频窗口移动 / 缩放 / 进出全屏时跟随停靠
  video.on('move', dockOverlay)
  video.on('resize', dockOverlay)
  video.on('enter-full-screen', dockOverlay)
  video.on('leave-full-screen', dockOverlay)

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
  const { bvid, autoFullscreen, topic } = payload
  if (!bvid) throw new Error('缺少视频 BV 号')
  currentTopic = topic ?? ''
  allowedBvs = [bvid]
  currentCtx = buildGuardContext(currentTopic, allowedBvs)

  // 幂等：先关闭旧窗口再开新窗口
  closeVideo()

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
    sendToMainWindow(IPC_EVENTS.bili.navBlocked, verdict)
    if (!video.isDestroyed()) {
      video.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBlockPageHtml(verdict))}`).catch(() => {
        /* 忽略 */
      })
    }
  }

  const handleIrrelevant = (verdict: NavVerdict): void => {
    sendToMainWindow(IPC_EVENTS.bili.navBlocked, verdict)
  }

  attachNavigationGuard(video.webContents, currentCtx, { onBlocked: handleBlocked, onIrrelevant: handleIrrelevant })

  // 全屏锁定（Esc/F11/缩小 均拉回）
  attachFullscreenLock(video, {
    autoFullscreen,
    active: () => !video.isDestroyed()
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

  const overlay = createOverlay(video)
  active = { video, overlay, bvid, autoFullscreen }

  video.once('ready-to-show', () => {
    video.show()
  })

  video.on('closed', () => {
    if (!overlay.isDestroyed()) overlay.destroy()
    active = null
    onCloseCallback?.()
    sendToMainWindow(IPC_EVENTS.bili.videoClosed, { bvid })
  })

  // 触发 onOpen 回调（启动强制会话）
  onOpenCallback?.(video, payload)

  sendToMainWindow(IPC_EVENTS.bili.videoOpened, {
    open: true,
    bvid,
    fullscreen: video.isFullScreen(),
    autoFullscreen
  } satisfies VideoState)
}

/** 关闭当前播放窗口（overlay 由 closed 事件级联销毁） */
export function closeVideo(): void {
  if (active && !active.video.isDestroyed()) {
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
    fullscreen: active.video.isFullScreen()
  }
}

/** 悬浮面板折叠 / 展开时调整窗口尺寸并重新停靠 */
export function resizeOverlay(size: OverlaySize): void {
  if (!active || active.overlay.isDestroyed()) return
  const width = Math.max(48, Math.round(size.width))
  const height = Math.max(48, Math.round(size.height))
  active.overlay.setSize(width, height)
  dockOverlay()
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