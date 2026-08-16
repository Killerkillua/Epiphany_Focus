import { ipcMain } from 'electron'
import Store from 'electron-store'
import { IPC_CHANNELS } from '../ipc'
import { SETTINGS_DEFAULTS, type AppSettings } from '../../shared/settings'

/**
 * 轻量配置存储（方案 3.4：用 electron-store）。
 * 文件：userData/settings.json；默认值见方案 4.2。
 * 各模块在使用时动态读取（即时生效，无需重启）。
 */

let store: Store<AppSettings> | null = null

function getStore(): Store<AppSettings> {
  if (!store) {
    store = new Store<AppSettings>({
      name: 'settings',
      defaults: SETTINGS_DEFAULTS
    })
  }
  return store
}

/** 返回完整设置快照 */
export function getSettings(): AppSettings {
  return getStore().store
}

/** 按点号路径批量写入（如 { 'pomodoro.focusMin': 30, 'ai.apiKey': 'sk-...' }），返回新快照 */
export function setSettings(entries: Record<string, unknown>): AppSettings {
  const s = getStore()
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue
    s.set(key, value as never)
  }
  return getSettings()
}

/** 注册 settings:get / settings:set */
export function registerSettingsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.settings.get, (): AppSettings => getSettings())
  ipcMain.handle(IPC_CHANNELS.settings.set, (_event, entries: Record<string, unknown>): AppSettings => {
    return setSettings(entries ?? {})
  })
}
