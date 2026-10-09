import { BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import Store from 'electron-store'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
import { ENV_KEY_API_KEY } from '../env'
import { SETTINGS_DEFAULTS, type AppSettings } from '../../shared/settings'
import { safeRecord } from '../validate'
import { ENFORCED_SESSION_FROZEN, validateRendererSetting } from './settingsSchema'
import { applyLaunchAtLogin } from '../launchAtLogin'
import { GUARDED_KEYS, readGuarded, writeGuarded, type GuardedPayload } from './guardStore'
import { getLogDir, getLogFilePath } from '../logger'

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

/** 旧版迁移：首次启用 guard 存储时，把 settings.json 中的现值签名固化 */
function legacyGuarded(): GuardedPayload {
  const raw = getStore().store as unknown as Record<string, unknown>
  const out: GuardedPayload = {}
  for (const k of GUARDED_KEYS) out[k] = raw[k]
  return out
}

/* ===== API Key 加密存储（Electron safeStorage：Windows DPAPI / macOS Keychain） ===== */

const ENC_PREFIX = 'enc:v1:'
/** 渲染层看到的 Key 掩码前缀；以此开头的写入一律视为"未修改"而忽略 */
export const API_KEY_MASK = '••••'

function getSafeStorage(): Electron.SafeStorage | undefined {
  try {
    const ss = safeStorage
    return ss && ss.isEncryptionAvailable() ? ss : undefined
  } catch {
    return undefined
  }
}

/** 明文 → 存储形态（可加密则加密，否则保持明文作为降级） */
function encryptApiKey(plain: string): string {
  if (!plain || plain.startsWith(ENC_PREFIX)) return plain
  const ss = getSafeStorage()
  if (!ss) return plain
  try {
    return ENC_PREFIX + ss.encryptString(plain).toString('base64')
  } catch {
    // Linux Secret Service 可能在 isEncryptionAvailable 为 true 时仍抛错
    return plain
  }
}

/** 存储形态 → 明文（解密失败返回空串，视为未配置） */
function decryptApiKey(stored: string): string {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored
  const ss = getSafeStorage()
  if (!ss) return ''
  try {
    return ss.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

/** 启动迁移：把旧版明文 Key 就地加密（不可加密环境下无操作） */
function migrateApiKeyEncryption(): void {
  const stored = getStore().get('ai.apiKey') as string | undefined
  if (stored && !stored.startsWith(ENC_PREFIX) && getSafeStorage()) {
    getStore().set('ai.apiKey', encryptApiKey(stored))
  }
}

function maskApiKey(plain: string): string {
  if (!plain) return ''
  return plain.length > 8 ? API_KEY_MASK + plain.slice(-4) : API_KEY_MASK
}

/**
 * 面向渲染层的设置快照：不含 API Key 明文（仅掩码）与恢复码哈希（仅占位标记）。
 * 主进程内部一律使用 getSettings()。
 */
export function getPublicSettings(): AppSettings {
  const s = getSettings()
  return {
    ...s,
    ai: { ...s.ai, apiKey: maskApiKey(s.ai.apiKey) },
    recoveryCodeHash: s.recoveryCodeHash ? 'set' : null
  }
}

/** 返回完整设置快照（含 API Key 明文，仅限主进程内部使用） */
export function getSettings(): AppSettings {
  // 受保护字段（recoveryCodeHash / enforced / lockLevel / sessionMaxHours / emergencyGuard）
  // 只认带 HMAC 签名的 guard.json，settings.json 中的同名字段被忽略，直接编辑无效。
  const guarded = readGuarded(legacyGuarded)
  const snapshot: AppSettings = { ...SETTINGS_DEFAULTS, ...getStore().store }
  for (const k of GUARDED_KEYS) {
    if (guarded[k] !== undefined) (snapshot as unknown as Record<string, unknown>)[k] = guarded[k]
    else (snapshot as unknown as Record<string, unknown>)[k] = SETTINGS_DEFAULTS[k]
  }
  snapshot.ai = { ...snapshot.ai, apiKey: decryptApiKey(snapshot.ai.apiKey ?? '') }
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
  const guardedPatch: Record<string, unknown> = {}
  let guardedBase: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue
    const [head, ...rest] = key.split('.')
    if ((GUARDED_KEYS as readonly string[]).includes(head)) {
      if (rest.length === 0) {
        guardedPatch[head] = value
      } else {
        // 点号路径写入受保护对象的子字段（如 'enforced.active'）
        guardedBase ??= readGuarded(legacyGuarded) as Record<string, unknown>
        const root = (guardedPatch[head] ?? structuredClone(guardedBase[head] ?? {})) as Record<
          string,
          unknown
        >
        let node = root
        for (const part of rest.slice(0, -1)) {
          node[part] = (node[part] as Record<string, unknown>) ?? {}
          node = node[part] as Record<string, unknown>
        }
        node[rest[rest.length - 1]] = value
        guardedPatch[head] = root
      }
      continue
    }
    s.set(
      key,
      (key === 'ai.apiKey' && typeof value === 'string' ? encryptApiKey(value) : value) as never
    )
  }
  if (Object.keys(guardedPatch).length > 0) writeGuarded(guardedPatch, legacyGuarded)
  const snapshot = getSettings()
  broadcastSettingsChanged(getPublicSettings())
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
const ALWAYS_BLOCKED_KEYS = new Set(['recoveryCodeHash', 'enforced', 'emergencyGuard'])
function isBlockedSettingsWrite(key: string): boolean {
  if (
    ALWAYS_BLOCKED_KEYS.has(key) ||
    key.startsWith('enforced.') ||
    key.startsWith('emergencyGuard.')
  ) {
    return true
  }
  if (getSettings().enforced?.active && ENFORCED_SESSION_FROZEN.has(key)) return true
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
    // 渲染层回传的掩码（设置页回填显示用）代表"未修改"，直接忽略
    if (key === 'ai.apiKey' && typeof value === 'string' && value.startsWith(API_KEY_MASK)) {
      continue
    }
    // 备份目录只接受"目录选择对话框"选出的路径（或空串 = 默认目录）
    if (key === 'backup.directory' && value !== '' && value !== lastPickedBackupDir) {
      throw new Error('备份目录必须通过「选择目录」对话框设置')
    }
    // 白名单 + 逐项类型/范围校验（未知键、越界值显式失败）
    result[key] = validateRendererSetting(key, value)
  }
  return result
}

/** 最近一次经原生对话框选定的备份目录（settings:set 仅认该值） */
let lastPickedBackupDir = ''

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * API 端点主机变更且已配置 Key 时，弹出原生确认框：
 * 防止被攻破的渲染进程把端点改到攻击者服务器以窃取 Key（原生对话框渲染层无法代点）。
 */
async function confirmEndpointChange(
  event: Electron.IpcMainInvokeEvent,
  clean: Record<string, unknown>
): Promise<void> {
  const next = clean['ai.baseURL']
  if (typeof next !== 'string') return
  const current = getSettings().ai
  if (!current.apiKey || hostOf(next) === hostOf(current.baseURL)) return
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = {
    type: 'warning' as const,
    title: '确认修改 API 端点',
    message: `你的 API Key 将发送到新的服务器：${hostOf(next)}`,
    detail: '仅当你信任该服务时才继续。',
    buttons: ['取消', '确认修改'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  if (res.response !== 1) throw new Error('已取消修改 API 端点')
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
  migrateApiKeyEncryption()
  // 渲染层只拿到脱敏快照（API Key 掩码、恢复码哈希占位）
  ipcMain.handle(IPC_CHANNELS.settings.get, (): AppSettings => getPublicSettings())
  ipcMain.handle(
    IPC_CHANNELS.settings.set,
    async (event, entries: Record<string, unknown>): Promise<AppSettings> => {
      // H-01 + CR-03：入参必须为对象；敏感键过滤 + 白名单逐项校验
      const clean = sanitizeRendererSettingsWrite(safeRecord(entries))
      await confirmEndpointChange(event, clean)
      setSettings(clean)
      if (Object.prototype.hasOwnProperty.call(clean, 'launchAtLogin')) {
        applyLaunchAtLogin(clean.launchAtLogin === true)
      }
      return getPublicSettings()
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
    if (result.canceled || !result.filePaths[0]) return null
    lastPickedBackupDir = result.filePaths[0]
    return lastPickedBackupDir
  })
  // 系统日志路径与目录打开
  ipcMain.handle(IPC_CHANNELS.settings.getLogPath, () => getLogFilePath())
  ipcMain.handle(IPC_CHANNELS.settings.openLogDir, async () => {
    const dir = getLogDir()
    await shell.openPath(dir)
    return dir
  })
}
