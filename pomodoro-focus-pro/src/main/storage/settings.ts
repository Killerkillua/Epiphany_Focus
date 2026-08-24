import { BrowserWindow, dialog, ipcMain } from 'electron'
import Store from 'electron-store'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
import { ENV_KEY_API_KEY } from '../env'
import { SETTINGS_DEFAULTS, type AppSettings } from '../../shared/settings'
import { safeRecord } from '../validate'

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

/**
 * 敏感设置保护（CR-03）：渲染层经 settings:set 不可写入的键。
 * 安全边界说明（放在 IPC 层而非 setSettings 内部）：
 * - 主进程内部模块（enforcement / emergencyExit）仍需直接写 enforced / recoveryCodeHash，
 *   因此通用通道的过滤只在渲染层入口处生效，内部调用不受影响。
 * - recoveryCodeHash / enforced（含 enforced.*）永远禁止渲染层写入：
 *   恢复码只能走 emergency:set-code（已验证旧码），强制会话状态仅主进程内部管理。
 * - lockLevel / sessionMaxHours 在强制会话进行中禁止写入：
 *   防止"改设置 → 绕过强制"（降级锁定级别 / 拉长会话上限）。
 *   空闲时允许写入（设置页正常配置入口）。
 */
const ALWAYS_BLOCKED_KEYS = new Set(['recoveryCodeHash', 'enforced'])
const ENFORCED_SESSION_BLOCKED_KEYS = new Set(['lockLevel', 'sessionMaxHours'])

function isBlockedSettingsWrite(key: string): boolean {
  if (ALWAYS_BLOCKED_KEYS.has(key) || key.startsWith('enforced.')) return true
  if (getSettings().enforced?.active && ENFORCED_SESSION_BLOCKED_KEYS.has(key)) return true
  return false
}

/** 过滤渲染层提交的设置条目：命中敏感键直接抛错（显式失败，不做静默丢弃） */
export function sanitizeRendererSettingsWrite(
  entries: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue
    if (isBlockedSettingsWrite(key)) {
      throw new Error(`敏感设置 ${key} 禁止经 settings:set 修改`)
    }
    result[key] = value
  }
  return result
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
  ipcMain.handle(
    IPC_CHANNELS.settings.set,
    (_event, entries: Record<string, unknown>): AppSettings => {
      // H-01 + CR-03：入参必须为对象；先过敏感键过滤（recoveryCodeHash / enforced / 强制会话中的 lockLevel 等）
      const e = safeRecord(entries)
      return setSettings(sanitizeRendererSettingsWrite(e))
    }
  )
  // M5：备份目录选择（返回目录路径；取消返回 null）
  ipcMain.handle(IPC_CHANNELS.settings.pickBackupDir, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '选择自动备份目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })
}
