import { BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { IPC_CHANNELS, IPC_EVENTS } from '../ipc'
import { ENV_KEY_API_KEY } from '../env'
import { SETTINGS_DEFAULTS, type AppSettings } from '../../shared/settings'

/**
 * 轻量配置存储（方案 3.4：用 electron-store）。
 * 文件：userData/settings.json；默认值见方案 4.2。
 * 各模块在使用时动态读取（即时生效，无需重启）。
 * 写入后向所有窗口广播 settings:changed，渲染层实时刷新（无需重新进入页面）。
 */

let store: Store<AppSettings> | null = null

function getStore(): Store<AppSettings> {
  if (!store) {
    store = new Store<AppSettings>({
      name: 'settings',
      defaults: SETTINGS_DEFAULTS,
      // 测试注入：Node 环境下指定 cwd 以脱离 Electron（生产环境不设置，走 userData）
      ...(process.env.POMODORO_SETTINGS_CWD ? { cwd: process.env.POMODORO_SETTINGS_CWD } : {})
    })
  }
  return store
}

/** 返回完整设置快照 */
export function getSettings(): AppSettings {
  const snapshot: AppSettings = { ...getStore().store }
  // .env 注入（根因 B 修复）：用户未显式配置 API Key（存储为空）时，
  // 回退到 .env 提供的 Key（主进程启动时经 loadEnvFile 注入 process.env）。
  // 仅在读取时回退、不落盘，保持 .env 为密钥唯一来源，且显式保存的 Key 始终优先。
  if (!snapshot.ai.apiKey && process.env[ENV_KEY_API_KEY]) {
    snapshot.ai = { ...snapshot.ai, apiKey: process.env[ENV_KEY_API_KEY] }
  }
  return snapshot
}

/** 按点号路径批量写入（如 { 'pomodoro.focusMin': 30, 'ai.apiKey': 'sk-...' }），返回新快照 */
export function setSettings(entries: Record<string, unknown>): AppSettings {
  const s = getStore()
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue
    s.set(key, value as never)
  }
  const snapshot = getSettings()
  broadcastSettingsChanged(snapshot)
  return snapshot
}

/** 广播最新设置快照：设置页保存后，英语学习等页面无需重进即可拿到新配置 */
function broadcastSettingsChanged(snapshot: AppSettings): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_EVENTS.settings.changed, snapshot)
    }
  }
}

/** 注册 settings:get / settings:set */
export function registerSettingsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.settings.get, (): AppSettings => getSettings())
  ipcMain.handle(IPC_CHANNELS.settings.set, (_event, entries: Record<string, unknown>): AppSettings => {
    return setSettings(entries ?? {})
  })
}
