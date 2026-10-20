import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { dirname, join } from 'path'

/**
 * 受保护设置存储（带完整性签名）。
 *
 * 威胁模型（务必阅读，见 README「威胁模型」）：
 * - 目标是"自律辅助"的防误改/防随手改，而不是安全边界。
 * - 防御对象：用户在应用运行中或关闭后直接编辑 settings.json
 *   （把 enforced 置空、降级 lockLevel、把 recoveryCodeHash 换成自己生成的 bcrypt 哈希、
 *   清零紧急退出失败计数等）。
 * - 这些字段不再从 settings.json 读取，而是存放在独立文件 guard.json，
 *   内容为 { payload, sig }，sig = HMAC-SHA256(key, payload)。
 * - HMAC 密钥随机生成，经系统凭据库（Electron safeStorage：Windows DPAPI / macOS Keychain）
 *   加密后落盘到 guard.key；safeStorage 不可用时降级为明文密钥文件（仅提高改文件的门槛）。
 * - 无法防御：同一系统用户下有意的攻击者（可调用同一 DPAPI 解密密钥、或整体删除
 *   guard.json + guard.key 回到"全新安装"状态、或回滚到旧的合法签名副本）。
 */

/** 受保护的顶层设置键 */
export const GUARDED_KEYS = [
  'recoveryCodeHash',
  'enforced',
  'lockLevel',
  'sessionMaxHours',
  'emergencyGuard'
] as const
export type GuardedKey = (typeof GUARDED_KEYS)[number]
export type GuardedPayload = Partial<Record<GuardedKey, unknown>>

interface GuardFile {
  payload: string
  sig: string
}

const GUARD_FILE = 'guard.json'
const BACKUP_FILE = 'guard.bak'
const KEY_FILE = 'guard.key'
const KEY_PREFIX_ENC = 'enc:'
const KEY_PREFIX_PLAIN = 'plain:'

/** 内存中最后一份已验证的负载：运行中文件被改时据此自愈 */
let cache: GuardedPayload | null = null
let cachedKey: Buffer | null = null
let tamperDetected = false

/** 测试用：重置内存状态 */
export function __resetGuardStoreForTests(): void {
  cache = null
  cachedKey = null
  tamperDetected = false
}

/** 是否发现过篡改（供日志 / UI 提示） */
export function wasTamperDetected(): boolean {
  return tamperDetected
}

function baseDir(): string {
  if (process.env.POMODORO_SETTINGS_CWD) return process.env.POMODORO_SETTINGS_CWD
  // 延迟 require：避免 Node 测试环境下加载 electron
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  return app.getPath('userData')
}

function getSafeStorage(): Electron.SafeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as typeof import('electron')
    if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage
  } catch {
    /* 非 Electron 环境 */
  }
  return null
}

function atomicWrite(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, file)
}

function createKeyFile(): Buffer {
  const key = randomBytes(32)
  const ss = getSafeStorage()
  const encoded = ss
    ? KEY_PREFIX_ENC + ss.encryptString(key.toString('hex')).toString('base64')
    : KEY_PREFIX_PLAIN + key.toString('hex')
  atomicWrite(join(baseDir(), KEY_FILE), encoded)
  cachedKey = key
  return key
}

/** 读取（或首次生成）HMAC 密钥；密钥文件存在但无法解密视为篡改，返回 null */
function loadKey(): { key: Buffer; created: boolean } | null {
  if (cachedKey) return { key: cachedKey, created: false }
  const keyPath = join(baseDir(), KEY_FILE)
  if (!existsSync(keyPath)) return { key: createKeyFile(), created: true }
  try {
    const raw = readFileSync(keyPath, 'utf8').trim()
    let key: Buffer
    if (raw.startsWith(KEY_PREFIX_ENC)) {
      const ss = getSafeStorage()
      if (!ss) return null
      key = Buffer.from(
        ss.decryptString(Buffer.from(raw.slice(KEY_PREFIX_ENC.length), 'base64')),
        'hex'
      )
    } else if (raw.startsWith(KEY_PREFIX_PLAIN)) {
      key = Buffer.from(raw.slice(KEY_PREFIX_PLAIN.length), 'hex')
    } else {
      return null
    }
    if (key.length !== 32) return null
    cachedKey = key
    return { key, created: false }
  } catch {
    return null
  }
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex')
}

function sigEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb)
}

/** 读取并验签指定文件；缺失 / 损坏 / 签名不符返回 null */
function readVerified(path: string, key: Buffer): GuardedPayload | null {
  try {
    if (!existsSync(path)) return null
    const file = JSON.parse(readFileSync(path, 'utf8')) as GuardFile
    if (
      typeof file.payload === 'string' &&
      typeof file.sig === 'string' &&
      sigEqual(file.sig, sign(key, file.payload))
    ) {
      return JSON.parse(file.payload) as GuardedPayload
    }
  } catch {
    /* 视为无效 */
  }
  return null
}

function writeGuard(key: Buffer, data: GuardedPayload): void {
  const payload = JSON.stringify(data)
  const body = JSON.stringify({ payload, sig: sign(key, payload) } satisfies GuardFile)
  // 先写备份再写主文件：任一被删 / 改坏，冷启动都能从另一份已验签副本恢复
  atomicWrite(join(baseDir(), BACKUP_FILE), body)
  atomicWrite(join(baseDir(), GUARD_FILE), body)
  cache = data
}

/**
 * 读取受保护负载。
 * @param legacy 首次启用（尚无密钥文件）时，用于从旧版 settings.json 迁移的取值函数
 */
export function readGuarded(legacy: () => GuardedPayload): GuardedPayload {
  const guardPath = join(baseDir(), GUARD_FILE)
  const loaded = loadKey()

  // 密钥不可用（被替换 / 损坏 / 凭据库解密失败）
  if (!loaded) return handleTamper('密钥文件不可用')

  // 首次启用：从旧版 settings.json 迁移并签名
  if (loaded.created) {
    writeGuard(loaded.key, legacy())
    return cache!
  }

  // 有密钥却没有 guard.json：guard.json 被删除
  if (!existsSync(guardPath)) return handleTamper('guard.json 缺失')

  const data = readVerified(guardPath, loaded.key)
  if (data) {
    cache = data
    return data
  }
  return handleTamper('签名校验失败')
}

/**
 * 篡改处理：
 * - 运行期（内存里有上一份已验证状态）：用内存副本覆盖回文件，编辑被撤销（自愈）。
 * - 冷启动（无内存副本）：无法得知原状态，按 fail-safe 重置为"无强制会话、无恢复码"，
 *   用户需重新设置恢复码；同时标记 tamperDetected 并写日志。
 */
function handleTamper(reason: string): GuardedPayload {
  tamperDetected = true
  console.warn(`[guardStore] 检测到受保护设置被篡改（${reason}）`)
  // 优先级：内存副本 > 已验签的 guard.bak > 重置默认（备份与主文件同时丢失才会走到）
  const fromBackup = cachedKey ? readVerified(join(baseDir(), BACKUP_FILE), cachedKey) : null
  const restored: GuardedPayload = cache ??
    fromBackup ?? { recoveryCodeHash: null, enforced: null }
  let key = cachedKey
  if (!key) {
    try {
      key = createKeyFile()
    } catch {
      key = null
    }
  }
  if (key) writeGuard(key, restored)
  else cache = restored
  return restored
}

/** 合并写入受保护负载（先校验当前文件，再带签名落盘） */
export function writeGuarded(patch: GuardedPayload, legacy: () => GuardedPayload): GuardedPayload {
  const current = readGuarded(legacy)
  const next = { ...current, ...patch }
  const key = cachedKey ?? loadKey()?.key ?? null
  if (key) writeGuard(key, next)
  else cache = next
  return next
}
