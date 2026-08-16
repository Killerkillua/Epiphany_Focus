import { app, shell, BrowserWindow, protocol } from 'electron'
import { join } from 'path'
import { registerEnforcementModule } from './enforcement'
import { registerNavigationModule } from './navigation'
import { registerAiIpc } from './ai'
import { registerAudioModule } from './audio'
import { registerSettingsIpc } from './storage/settings'
import { registerStatsIpc } from './storage/stats'
import { getDb } from './storage/db'

/**
 * 主进程入口：窗口管理 + 模块装配（方案 3.3 进程模型）。
 * - enforcement：强制引擎（锁定分级 / 计时联动 / 紧急退出 / 重启恢复 / 学习统计落库）
 * - navigation：B 站模式（WBI 搜索 / 播放窗口 / 导航管控 / 悬浮面板 / 记事本）
 * - ai：英语模式（分层 Prompt + RAG + BYOK + 生词本/语法要点）
 * - audio：白噪音（全局热键 / 采样素材解析 / tomato-audio:// 自定义协议）
 * - settings / stats：全局设置（electron-store）与学习统计聚合
 */

// 自定义协议：必须在 app.ready 前声明特权（方案 2.8 §3 落地设计）
protocol.registerSchemesAsPrivileged([
  { scheme: 'tomato-audio', privileges: { standard: true, secure: true, stream: true } }
])

const isDev = !app.isPackaged

/** 当前主窗口（惰性获取：macOS activate 重建窗口后仍能取到最新实例） */
function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: '番茄专注 Pro',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 防绕过矩阵：devTools 关闭（开发模式可在启动参数开启）
      devTools: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 外部链接一律交给系统浏览器，禁止在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发模式加载 electron-vite dev server，生产模式加载构建产物
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  createMainWindow()

  // 预打开中央 SQLite（创建规约 6 张表，方案 3.4）
  getDb()

  // 全局设置（electron-store）与学习统计（先于其他模块，供其读取）
  registerSettingsIpc()
  registerStatsIpc()

  // 强制引擎（计时 / 锁定分级 / 紧急退出 / 分心拦截 / 守护进程）
  const enforcement = registerEnforcementModule(getMainWindow)

  // B 站模式（接入强制引擎 + 四层导航判定）
  registerNavigationModule(getMainWindow, enforcement)

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
