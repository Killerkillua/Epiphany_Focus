import { app, shell, BrowserWindow, protocol, ipcMain } from 'electron'
import { join } from 'path'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import { registerEnforcementModule } from './enforcement'
import { registerNavigationModule } from './navigation'
import { closeVideo } from './navigation/biliWindow'
import { installBiliImageProxy } from './navigation/biliImageProxy'
import { registerAiIpc } from './ai'
import { registerAudioModule } from './audio'
import { loadEnvFile } from './env'
import { registerSettingsIpc } from './storage/settings'
import { registerStatsIpc } from './storage/stats'
import { registerTaskIpc } from './storage/tasks'
import { registerAuthIpc } from './auth'
import { startAutoBackup } from './storage/backup'
import { getDb } from './storage/db'
import { registerSessionModule } from './session'
import { getAppIcon } from './icon'
import { logger, getLogFilePath } from './logger'

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
  }
])

const isDev = !app.isPackaged

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

/** 已有实例被再次启动时，把主窗口拉到前台 */
function focusMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.moveTop()
  win.focus()
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
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
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

  createMainWindow()
  registerWindowControlIpc()

  // 视频学习封面图代理（bili-image:// 协议 + Referer 注入 + 磁盘缓存），修复 CDN 防盗链 403
  installBiliImageProxy()

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
  const enforcement = registerEnforcementModule(getMainWindow, { closeVideo })

  // 学习会话计时（视频学习 / 英语模式，与强制引擎解耦；返回遮罩联动句柄）
  const session = registerSessionModule(getMainWindow)

  // 视频学习模式（接入强制引擎 + 四层导航判定 + 学习会话遮罩联动）
  registerNavigationModule(getMainWindow, enforcement, session)

  // AI 网关（英语模式）
  registerAiIpc()

  // 白噪音（全局热键 + 采样素材解析）
  registerAudioModule(getMainWindow)

  // 重启后恢复强制会话（防重启绕过，方案 2.5）
  enforcement.restoreAfterRestart()

  // macOS：点击 Dock 图标且无窗口时重新创建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

// Windows / Linux：所有窗口关闭即退出（macOS 保留在 Dock）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
