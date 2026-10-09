import { app, shell, BrowserWindow, protocol, ipcMain } from 'electron'
import { join } from 'path'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import { registerEnforcementModule } from './enforcement'
import { registerNavigationModule } from './navigation'
import { closeVideo } from './navigation/biliWindow'
import { installBiliImageProxy } from './navigation/biliImageProxy'
import { installLocalMediaProtocol } from './study/localMediaProtocol'
import { registerStudyModule } from './study'
import { registerAiIpc } from './ai'
import { registerAudioModule } from './audio'
import { loadEnvFile } from './env'
import { getSettings, registerSettingsIpc } from './storage/settings'
import { registerStatsIpc } from './storage/stats'
import { registerTaskIpc } from './storage/tasks'
import { registerAuthIpc } from './auth'
import { startAutoBackup } from './storage/backup'
import { getDb } from './storage/db'
import { registerSessionModule } from './session'
import { getAppIcon } from './icon'
import { logger, getLogFilePath } from './logger'
import { APP_USER_MODEL_ID } from './notify'
import { applyLaunchAtLogin, wasOpenedAsHidden } from './launchAtLogin'
import { installAppTray } from './tray'

/**
 * 主进程入口：窗口管理 + 模块装配（方案 3.3 进程模型）。
 * - enforcement：强制引擎（锁定分级 / 计时联动 / 紧急退出 / 重启恢复 / 学习统计落库）
 * - navigation：视频学习模式（WBI 搜索 / 播放窗口 / 导航管控 / 悬浮面板 / 记事本）
 * - ai：英语模式（分层 Prompt + RAG + BYOK + 生词本/语法要点）
 * - audio：白噪音（全局热键 / 采样素材解析 / tomato-audio:// 自定义协议）
 * - settings / stats：全局设置（electron-store）与学习统计聚合
 */

// 自定义协议：必须在 app.ready 前声明特权（方案 2.8 §3 落地设计）
// supportFetchAPI：允许渲染层 fetch() 该协议（缺省则 fetch 直接失败 → 采样轨全部跳过）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'tomato-audio',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  },
  {
    scheme: 'bili-image',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
      // H-05：移除 bypassCSP——渲染层 CSP 已用 img-src 显式放行 bili-image:，
      // 无需给该协议"绕过全部 CSP"的后门特权（最小权限原则）。
    }
  },
  {
    scheme: 'tomato-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

const isDev = !app.isPackaged

// Windows 通知要认这个身份，必须和 electron-builder.yml 的 appId 一致，且早于任何 Notification
app.setAppUserModelId(APP_USER_MODEL_ID)

/** 托盘菜单或系统触发的真正退出；为 false 时关闭主窗口只是藏进托盘 */
let isQuitting = false
/** 托盘创建失败时退回「关掉窗口就退出」 */
let trayEnabled = false
/** 第二实例来得比主窗口更早时，等窗口创建后再拉到前台 */
let pendingFocus = false
/** 开机登录项以隐藏方式拉起：第一扇主窗口先不显示 */
let suppressInitialShow = false
/** 强制引擎注册前恒为 false；L1/L2 会话中为 true */
let isQuitBlocked = (): boolean => false

/**
 * H-03：全局异步异常保护。Electron 主进程存在大量"发射后不管"的 Promise
 * （如 void saveCacheIndex()），任一 rejection 若未捕获，Node 20+（Electron 33 内置）
 * 默认会让进程直接退出。此处统一兜底：记录日志、阻止静默丢失，避免应用意外崩溃。
 * 只做日志 + 不崩溃，业务层仍需各自 try/catch；这是最后的防御线。
 */
process.on('unhandledRejection', (reason) => {
  logger.error('main', '未处理的 Promise rejection:', reason)
})

process.on('uncaughtException', (error) => {
  logger.error('main', '未捕获的异常:', error)
})

/**
 * 主窗口引用。视频窗和悬浮面板也是 BrowserWindow，
 * getAllWindows()[0] 在它们位于列表首位时会拿到错误窗口。
 * macOS activate 重建时由 createMainWindow 更新此引用。
 */
let mainWindowRef: BrowserWindow | null = null

function getMainWindow(): BrowserWindow | null {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return null
  return mainWindowRef
}

/** 已有实例被再次启动、或托盘要求显示时，把主窗口拉到前台。窗口还不存在则返回 false */
function focusMainWindow(): boolean {
  const win = getMainWindow()
  if (!win) return false
  // 用户已经要求看到窗口，开机隐藏不能再把它藏回去
  suppressInitialShow = false
  pendingFocus = false
  if (win.isMinimized()) win.restore()
  win.show()
  if (!isQuitBlocked()) win.setSkipTaskbar(false)
  win.moveTop()
  win.focus()
  return true
}

/** 外链协议白名单：仅 http/https，杜绝 file:/smb:/自定义协议处理器被诱导调用 */
function isSafeExternalUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** 是否为应用自身页面（开发 dev server 或打包 file:// 页面） */
function isAppUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (isDev && dev) return url.origin === new URL(dev).origin
    return url.protocol === 'file:'
  } catch {
    return false
  }
}

function createMainWindow(): BrowserWindow {
  const appIcon = getAppIcon()
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    title: '静界专注',
    backgroundColor: '#0f1115',
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程沙箱：preload 仅使用 electron 模块与已打包的 shared 代码，可在沙箱下运行
      sandbox: true,
      // 防绕过矩阵：devTools 关闭（开发模式可在启动参数开启）
      devTools: false
    }
  })

  mainWindowRef = mainWindow
  let renderReloads = 0
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  const MAX_RENDER_RELOADS = 3

  mainWindow.on('closed', () => {
    if (stableTimer) clearTimeout(stableTimer)
    if (mainWindowRef === mainWindow) mainWindowRef = null
  })

  mainWindow.on('ready-to-show', () => {
    const hide = suppressInitialShow && !pendingFocus
    suppressInitialShow = false
    pendingFocus = false
    if (hide) {
      mainWindow.hide()
      mainWindow.setSkipTaskbar(true)
      return
    }
    mainWindow.show()
    if (!isQuitBlocked()) mainWindow.setSkipTaskbar(false)
  })

  // 非强制会话：关闭只藏进托盘。强制会话仍由 lockScreen 拦截关闭，这里再挡一层避免藏起来绕过全屏锁
  mainWindow.on('close', (event) => {
    if (isQuitting || !trayEnabled) return
    event.preventDefault()
    if (isQuitBlocked()) return
    mainWindow.hide()
    mainWindow.setSkipTaskbar(true)
  })

  // React Error Boundary 抓不到渲染进程崩溃。有限次重载，避免 L1/L2 全屏白屏后无法连按 Esc
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('main', `渲染进程退出 reason=${details.reason} exit=${details.exitCode}`)
    if (details.reason === 'clean-exit') return
    if (mainWindow.isDestroyed()) return
    if (renderReloads >= MAX_RENDER_RELOADS) {
      logger.error('main', '渲染进程反复崩溃，已停止自动重载')
      return
    }
    renderReloads += 1
    logger.info('main', `正在重载界面（${renderReloads}/${MAX_RENDER_RELOADS}）`)
    mainWindow.webContents.reload()
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (stableTimer) clearTimeout(stableTimer)
    stableTimer = setTimeout(() => {
      renderReloads = 0
    }, 10_000)
  })

  mainWindow.on('maximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENTS.window.maximizeChanged, true)
    }
  })

  mainWindow.on('unmaximize', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENTS.window.maximizeChanged, false)
    }
  })

  // 外部链接一律交给系统浏览器，禁止在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // 主窗口只允许停留在应用自身页面：任何其它导航（含 Markdown 链接点击）一律拦截，
  // 其中 http(s) 链接转交系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  // 开发模式加载 electron-vite dev server，生产模式加载构建产物
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function registerWindowControlIpc(): void {
  ipcMain.handle(IPC_CHANNELS.window.minimize, () => {
    const win = getMainWindow()
    win?.minimize()
  })

  ipcMain.handle(IPC_CHANNELS.window.maximize, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.handle(IPC_CHANNELS.window.close, () => {
    const win = getMainWindow()
    win?.close()
  })

  ipcMain.handle(IPC_CHANNELS.window.isMaximized, () => {
    const win = getMainWindow()
    return win ? win.isMaximized() : false
  })

  ipcMain.handle(IPC_CHANNELS.app.isPackaged, () => app.isPackaged)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!focusMainWindow()) pendingFocus = true
  })
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    app.quit()
    return
  }

  logger.info('main', `静界专注主进程已启动，系统日志写入: ${getLogFilePath()}`)
  // .env 加载必须在任何模块读取配置之前（根因 B 修复）：
  // 把应用根目录 .env 中的 POMODORO_AI_API_KEY 注入 process.env，
  // 供 settings 默认值回退使用（见 storage/settings.ts getSettings）。
  loadEnvFile()

  suppressInitialShow = wasOpenedAsHidden()
  createMainWindow()
  registerWindowControlIpc()

  // 视频学习封面图代理（bili-image:// 协议 + Referer 注入 + 磁盘缓存），修复 CDN 防盗链 403
  installBiliImageProxy()
  installLocalMediaProtocol()

  // 预打开中央 SQLite（创建规约 6 张表，方案 3.4）
  getDb()

  // 全局设置（electron-store）与学习统计（先于其他模块，供其读取）
  // 本地账号（先于所有读写业务库的模块：自动登录会切换当前账号的数据库文件）
  registerAuthIpc()
  registerSettingsIpc()
  registerStatsIpc()
  registerTaskIpc()

  // M5 自动备份调度（读 settings.backup；启动时若已过备份时刻则补备）
  startAutoBackup()

  // 强制引擎（计时 / 锁定分级 / 紧急退出 / 分心拦截 / 守护进程）。
  // CR-05：closeVideo 由装配层注入，enforcement 不反向 import navigation（消除循环依赖）
  const enforcement = registerEnforcementModule(getMainWindow, {
    closeVideo,
    closeStudyWindow: closeVideo
  })
  isQuitBlocked = () => enforcement.isQuitBlocked()

  // 学习会话计时（视频学习 / 英语模式，与强制引擎解耦；返回遮罩联动句柄）
  const session = registerSessionModule(getMainWindow)

  // 视频学习模式（接入强制引擎 + 四层导航判定 + 学习会话遮罩联动）
  registerNavigationModule(getMainWindow, enforcement, session)
  // 本地视频与白名单网站。注册独立于 B 站预热，搜索服务异常不影响这两个入口。
  registerStudyModule(getMainWindow)

  // AI 网关（英语模式）
  registerAiIpc()

  // 白噪音（全局热键 + 采样素材解析）
  registerAudioModule(getMainWindow)

  try {
    const tray = installAppTray(enforcement, {
      showWindow: () => {
        if (!focusMainWindow()) pendingFocus = true
      },
      requestQuit: () => {
        if (isQuitBlocked()) {
          focusMainWindow()
          return
        }
        app.quit()
      }
    })
    trayEnabled = true
    app.on('will-quit', () => tray.destroy())
  } catch (err) {
    logger.error('main', '系统托盘创建失败，关闭窗口将退出应用:', err)
  }

  applyLaunchAtLogin(getSettings().launchAtLogin === true)

  // 重启后恢复强制会话（防重启绕过，方案 2.5）。托盘已就绪，恢复后的 tick 能刷新 Tooltip
  enforcement.restoreAfterRestart()

  app.on('before-quit', (event) => {
    if (isQuitBlocked()) {
      event.preventDefault()
      focusMainWindow()
      return
    }
    isQuitting = true
  })

  // macOS：点击 Dock 图标时显示已隐藏的主窗口；窗口已被销毁才重建
  app.on('activate', () => {
    if (!getMainWindow()) createMainWindow()
    else focusMainWindow()
  })
})

// 托盘常驻时隐藏窗口不算退出。托盘创建失败时，Windows / Linux 仍在最后一个窗口关闭后退出
app.on('window-all-closed', () => {
  if (trayEnabled) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
