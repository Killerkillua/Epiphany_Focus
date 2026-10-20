import bcrypt from 'bcryptjs'
import { app, ipcMain, safeStorage } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipc'
import {
  AUTH_RULES,
  validateNickname,
  validatePassword,
  validateUsername,
  type AuthFail,
  type AuthResult,
  type AuthState,
  type AuthUser,
  type DeleteAccountPayload,
  type LoginPayload,
  type RegisterPayload,
  type ResetPasswordPayload
} from '../../shared/auth'
import {
  LEGACY_DB_FILE,
  closeDb,
  openSqlite,
  setActiveDbFile,
  type SqliteLike
} from '../storage/db'
import { bool, obj, str } from '../validate'

/**
 * 本地账号服务：
 * - 账号表存于独立的 auth.db（users / login_sessions），密码与恢复码均为 bcrypt 哈希
 * - 每个账号独立一个业务数据库文件（db.ts 的 setActiveDbFile 切换），业务查询天然按账号隔离
 * - 首个注册账号接管升级前已有的 pomodoro.db；游客使用 guest.db
 * - 自动登录令牌：随机 32 字节，库中仅存 SHA-256；令牌本体只保存在主进程侧文件（safeStorage 加密），
 *   渲染层永远拿不到哈希或令牌
 */

const BCRYPT_ROUNDS = 10
const GUEST_DB_FILE = 'guest.db'
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** 用户名不存在时仍做一次 bcrypt 比较，抹平响应时间差 */
const DUMMY_HASH = bcrypt.hashSync('dummy-password-1', BCRYPT_ROUNDS)

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nickname TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  db_file TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);
CREATE TABLE IF NOT EXISTS login_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`

interface UserRow {
  id: number
  username: string
  nickname: string
  password_hash: string
  recovery_hash: string
  db_file: string
  failed_attempts: number
  locked_until: number | null
}

let authDb: SqliteLike | null = null
let state: AuthState = { status: 'loggedOut' }
let currentDbFile = GUEST_DB_FILE

function now(): number {
  return Date.now()
}

function getAuthDb(): SqliteLike {
  if (authDb) return authDb
  const path = process.env.POMODORO_AUTH_DB_PATH || join(app.getPath('userData'), 'auth.db')
  const d = openSqlite(path)
  d.exec(AUTH_SCHEMA)
  authDb = d
  return d
}

function tokenFilePath(): string {
  return process.env.POMODORO_AUTH_TOKEN_PATH || join(app.getPath('userData'), 'auth-session.bin')
}

/** 测试隔离：释放 auth.db 连接并重置内存状态 */
export function resetAuthForTest(): void {
  try {
    authDb?.close?.()
  } catch {
    /* 忽略 */
  }
  authDb = null
  state = { status: 'loggedOut' }
  currentDbFile = GUEST_DB_FILE
}

// ================= 令牌文件（自动登录） =================

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

const TOKEN_ENC = 'enc:'
const TOKEN_PLAIN = 'plain:'

function writeToken(token: string): void {
  try {
    let body: Buffer
    try {
      if (safeStorage?.isEncryptionAvailable?.()) {
        body = Buffer.concat([Buffer.from(TOKEN_ENC), safeStorage.encryptString(token)])
      } else {
        body = Buffer.from(TOKEN_PLAIN + token, 'utf8')
      }
    } catch {
      body = Buffer.from(TOKEN_PLAIN + token, 'utf8')
    }
    writeFileSync(tokenFilePath(), body)
  } catch {
    /* 写入失败只影响自动登录 */
  }
}

type TokenRead = { kind: 'token'; token: string } | { kind: 'none' } | { kind: 'unavailable' }

function readToken(): TokenRead {
  try {
    const p = tokenFilePath()
    if (!existsSync(p)) return { kind: 'none' }
    const buf = readFileSync(p)
    if (buf.subarray(0, TOKEN_PLAIN.length).toString('utf8') === TOKEN_PLAIN) {
      return { kind: 'token', token: buf.subarray(TOKEN_PLAIN.length).toString('utf8') }
    }
    if (buf.subarray(0, TOKEN_ENC.length).toString('utf8') === TOKEN_ENC) {
      try {
        if (!safeStorage?.isEncryptionAvailable?.()) return { kind: 'unavailable' }
        return { kind: 'token', token: safeStorage.decryptString(buf.subarray(TOKEN_ENC.length)) }
      } catch {
        return { kind: 'unavailable' }
      }
    }
    // 旧文件没有前缀
    try {
      if (safeStorage?.isEncryptionAvailable?.()) {
        return { kind: 'token', token: safeStorage.decryptString(buf) }
      }
    } catch {
      return { kind: 'unavailable' }
    }
    return { kind: 'token', token: buf.toString('utf8') }
  } catch {
    return { kind: 'none' }
  }
}

function clearTokenFile(): void {
  try {
    rmSync(tokenFilePath(), { force: true })
  } catch {
    /* 忽略 */
  }
}

function issueSession(userId: number): void {
  const token = randomBytes(32).toString('hex')
  const t = now()
  getAuthDb()
    .prepare(
      'INSERT INTO login_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(sha256(token), userId, t + AUTH_RULES.sessionTtlMs, t)
  writeToken(token)
}

function revokeSessions(userId: number): void {
  getAuthDb().prepare('DELETE FROM login_sessions WHERE user_id = ?').run(userId)
  clearTokenFile()
}

// ================= 工具 =================

function fail(error: string, retryInSec?: number): AuthFail {
  return retryInSec ? { ok: false, error, retryInSec } : { ok: false, error }
}

function toUser(row: Pick<UserRow, 'id' | 'username' | 'nickname'>): AuthUser {
  return { id: row.id, username: row.username, nickname: row.nickname }
}

function getUserByName(username: string): UserRow | undefined {
  return getAuthDb()
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as UserRow | undefined
}

function getUserById(id: number): UserRow | undefined {
  return getAuthDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
}

/** 生成恢复码：16 位去歧义字符，格式 XXXX-XXXX-XXXX-XXXX（约 80 bit 熵） */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(16)
  let out = ''
  for (let i = 0; i < 16; i++) {
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length]
    if (i % 4 === 3 && i < 15) out += '-'
  }
  return out
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase()
}

/** 切换业务数据库并更新内存状态 */
function applyState(next: AuthState, dbFile: string): void {
  state = next
  currentDbFile = dbFile
  setActiveDbFile(dbFile)
}

/** 记录一次失败并按需锁定，返回锁定剩余秒数（未锁定为 0） */
function registerFailure(row: UserRow): number {
  const attempts = row.failed_attempts + 1
  let lockedUntil: number | null = null
  let lockSec = 0
  if (attempts % AUTH_RULES.maxFailures === 0) {
    const round = attempts / AUTH_RULES.maxFailures
    lockSec = Math.min(AUTH_RULES.lockBaseSec * 2 ** (round - 1), AUTH_RULES.lockMaxSec)
    lockedUntil = now() + lockSec * 1000
  }
  getAuthDb()
    .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
    .run(attempts, lockedUntil, row.id)
  return lockSec
}

function clearFailures(userId: number): void {
  getAuthDb()
    .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(userId)
}

function lockRemainingSec(row: UserRow): number {
  if (!row.locked_until || row.locked_until <= now()) return 0
  return Math.ceil((row.locked_until - now()) / 1000)
}

function failureMessage(row: UserRow, what: string): AuthFail {
  const lockSec = registerFailure(row)
  if (lockSec > 0) return fail('尝试次数过多，账号已被临时锁定', lockSec)
  const left = AUTH_RULES.maxFailures - ((row.failed_attempts + 1) % AUTH_RULES.maxFailures)
  return fail(`${what}错误，还可尝试 ${left} 次`)
}

// ================= 对外 API =================

export function getAuthState(): AuthState {
  return state
}

/** 启动时调用：尝试用本机令牌自动登录（同步，仅 SHA-256 查表） */
export function initAuth(): AuthState {
  setActiveDbFile(GUEST_DB_FILE)
  const token = readToken()
  if (token.kind === 'unavailable') return state
  if (token.kind === 'token') {
    const row = getAuthDb()
      .prepare(
        `SELECT u.* FROM login_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(sha256(token.token), now()) as UserRow | undefined
    if (row) {
      getAuthDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id)
      applyState({ status: 'user', user: toUser(row) }, row.db_file)
      return state
    }
    clearTokenFile()
  }
  // 清理过期令牌
  getAuthDb().prepare('DELETE FROM login_sessions WHERE expires_at <= ?').run(now())
  return state
}

export async function register(
  p: RegisterPayload
): Promise<AuthResult<{ user: AuthUser; recoveryCode: string }>> {
  const username = p.username.trim()
  const nickname = (p.nickname ?? '').trim()
  const err = validateUsername(username) ?? validatePassword(p.password) ?? validateNickname(nickname)
  if (err) return fail(err)
  if (getUserByName(username)) return fail('用户名已被占用')

  const recoveryCode = generateRecoveryCode()
  const [passwordHash, recoveryHash] = await Promise.all([
    bcrypt.hash(p.password, BCRYPT_ROUNDS),
    bcrypt.hash(normalizeRecoveryCode(recoveryCode), BCRYPT_ROUNDS)
  ])
  // await 期间可能有并发注册同名用户，UNIQUE 约束兜底
  const d = getAuthDb()
  let id: number
  try {
    const res = d
      .prepare(
        `INSERT INTO users (username, nickname, password_hash, recovery_hash, db_file, created_at, last_login_at)
         VALUES (?, ?, ?, ?, '', ?, ?)`
      )
      .run(username, nickname || username, passwordHash, recoveryHash, now(), now())
    id = Number(res.lastInsertRowid)
  } catch {
    return fail('用户名已被占用')
  }
  // 首个注册账号接管升级前已有的数据；其后每个账号独立文件
  const legacyTaken = d.prepare('SELECT 1 FROM users WHERE db_file = ?').get(LEGACY_DB_FILE)
  const dbFile = legacyTaken ? `user-${id}.db` : LEGACY_DB_FILE
  d.prepare('UPDATE users SET db_file = ? WHERE id = ?').run(dbFile, id)

  const user: AuthUser = { id, username, nickname: nickname || username }
  applyState({ status: 'user', user }, dbFile)
  revokeSessions(id)
  issueSession(id) // 新注册默认保持登录
  return { ok: true, user, recoveryCode }
}

export async function login(p: LoginPayload): Promise<AuthResult<{ user: AuthUser }>> {
  const row = getUserByName(p.username)
  if (!row) {
    await bcrypt.compare(p.password, DUMMY_HASH)
    return fail('用户名或密码错误')
  }
  const remain = lockRemainingSec(row)
  if (remain > 0) return fail('尝试次数过多，账号已被临时锁定', remain)

  if (!(await bcrypt.compare(p.password, row.password_hash))) {
    return failureMessage(row, '用户名或密码')
  }
  clearFailures(row.id)
  getAuthDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id)
  revokeSessions(row.id)
  if (p.remember) issueSession(row.id)
  applyState({ status: 'user', user: toUser(row) }, row.db_file)
  return { ok: true, user: toUser(row) }
}

export function loginGuest(): AuthResult {
  clearTokenFile()
  applyState({ status: 'guest' }, GUEST_DB_FILE)
  return { ok: true }
}

export function logout(): AuthResult {
  if (state.status === 'user') revokeSessions(state.user.id)
  clearTokenFile()
  applyState({ status: 'loggedOut' }, GUEST_DB_FILE)
  return { ok: true }
}

/**
 * 校验当前登录账号的密码（修改紧急恢复码等敏感操作）。
 * 失败计入登录锁定，避免绕过登录失败次数限制。
 */
export async function verifyCurrentPassword(password: string): Promise<AuthResult> {
  if (state.status !== 'user') return fail('请先登录账号')
  const row = getUserById(state.user.id)
  if (!row) return fail('账号不存在')
  const remain = lockRemainingSec(row)
  if (remain > 0) return fail('尝试次数过多，账号已被临时锁定', remain)
  if (!(await bcrypt.compare(password, row.password_hash))) {
    return failureMessage(row, '密码')
  }
  clearFailures(row.id)
  return { ok: true }
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<AuthResult> {
  if (state.status !== 'user') return fail('请先登录账号')
  const row = getUserById(state.user.id)
  if (!row) return fail('账号不存在')
  const remain = lockRemainingSec(row)
  if (remain > 0) return fail('尝试次数过多，账号已被临时锁定', remain)
  const err = validatePassword(newPassword)
  if (err) return fail(err)
  if (!(await bcrypt.compare(oldPassword, row.password_hash))) {
    return failureMessage(row, '原密码')
  }
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  getAuthDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.id)
  clearFailures(row.id)
  revokeSessions(row.id) // 其它设备/旧令牌全部失效
  return { ok: true }
}

export function updateNickname(nickname: string): AuthResult<{ user: AuthUser }> {
  if (state.status !== 'user') return fail('请先登录账号')
  const nick = nickname.trim()
  const err = validateNickname(nick)
  if (err) return fail(err)
  const finalNick = nick || state.user.username
  getAuthDb().prepare('UPDATE users SET nickname = ? WHERE id = ?').run(finalNick, state.user.id)
  const user = { ...state.user, nickname: finalNick }
  state = { status: 'user', user }
  return { ok: true, user }
}

export async function deleteAccount(p: DeleteAccountPayload): Promise<AuthResult> {
  if (state.status !== 'user') return fail('请先登录账号')
  const row = getUserById(state.user.id)
  if (!row) return fail('账号不存在')
  const remain = lockRemainingSec(row)
  if (remain > 0) return fail('尝试次数过多，账号已被临时锁定', remain)
  if (!(await bcrypt.compare(p.password, row.password_hash))) {
    return failureMessage(row, '密码')
  }
  const d = getAuthDb()
  revokeSessions(row.id)
  d.prepare('DELETE FROM users WHERE id = ?').run(row.id)
  // 先切走业务库并关闭连接，才能删除文件
  applyState({ status: 'loggedOut' }, GUEST_DB_FILE)
  closeDb()
  if (p.deleteData && !process.env.POMODORO_DB_PATH) {
    const base = join(app.getPath('userData'), row.db_file)
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        rmSync(base + suffix, { force: true })
      } catch {
        /* 文件被占用时忽略，数据残留但账号已删除 */
      }
    }
  }
  return { ok: true }
}

/** 恢复码重置密码；成功后恢复码轮换（旧码作废），不自动登录 */
export async function resetPassword(
  p: ResetPasswordPayload
): Promise<AuthResult<{ recoveryCode: string }>> {
  const pwdErr = validatePassword(p.newPassword)
  if (pwdErr) return fail(pwdErr)
  const row = getUserByName(p.username)
  if (!row) {
    await bcrypt.compare(p.recoveryCode, DUMMY_HASH)
    return fail('用户名或恢复码错误')
  }
  const remain = lockRemainingSec(row)
  if (remain > 0) return fail('尝试次数过多，账号已被临时锁定', remain)
  if (!(await bcrypt.compare(normalizeRecoveryCode(p.recoveryCode), row.recovery_hash))) {
    return failureMessage(row, '用户名或恢复码')
  }
  const recoveryCode = generateRecoveryCode()
  const [passwordHash, recoveryHash] = await Promise.all([
    bcrypt.hash(p.newPassword, BCRYPT_ROUNDS),
    bcrypt.hash(normalizeRecoveryCode(recoveryCode), BCRYPT_ROUNDS)
  ])
  getAuthDb()
    .prepare('UPDATE users SET password_hash = ?, recovery_hash = ? WHERE id = ?')
    .run(passwordHash, recoveryHash, row.id)
  clearFailures(row.id)
  getAuthDb().prepare('DELETE FROM login_sessions WHERE user_id = ?').run(row.id)
  return { ok: true, recoveryCode }
}

/** 当前账号对应的数据库文件名（调试/测试用） */
export function getCurrentDbFile(): string {
  return currentDbFile
}

// ================= IPC =================

export function registerAuthIpc(): void {
  initAuth()

  ipcMain.handle(IPC_CHANNELS.auth.getState, (): AuthState => getAuthState())

  ipcMain.handle(IPC_CHANNELS.auth.register, (_e, raw: unknown) => {
    const o = obj(raw, 'auth.register')
    return register({
      username: str(o.username, 'username', { max: 100 }),
      password: str(o.password, 'password', { max: 200 }),
      nickname: str(o.nickname ?? '', 'nickname', { max: 100, allowEmpty: true })
    })
  })

  ipcMain.handle(IPC_CHANNELS.auth.login, (_e, raw: unknown) => {
    const o = obj(raw, 'auth.login')
    return login({
      username: str(o.username, 'username', { max: 100 }),
      password: str(o.password, 'password', { max: 200 }),
      remember: bool(o.remember ?? false, 'remember')
    })
  })

  ipcMain.handle(IPC_CHANNELS.auth.loginGuest, () => loginGuest())
  ipcMain.handle(IPC_CHANNELS.auth.logout, () => logout())

  ipcMain.handle(IPC_CHANNELS.auth.changePassword, (_e, oldPwd: unknown, newPwd: unknown) =>
    changePassword(str(oldPwd, 'oldPassword', { max: 200 }), str(newPwd, 'newPassword', { max: 200 }))
  )

  ipcMain.handle(IPC_CHANNELS.auth.updateNickname, (_e, nickname: unknown) =>
    updateNickname(str(nickname ?? '', 'nickname', { max: 100, allowEmpty: true }))
  )

  ipcMain.handle(IPC_CHANNELS.auth.deleteAccount, (_e, raw: unknown) => {
    const o = obj(raw, 'auth.deleteAccount')
    return deleteAccount({
      password: str(o.password, 'password', { max: 200 }),
      deleteData: bool(o.deleteData, 'deleteData')
    })
  })

  ipcMain.handle(IPC_CHANNELS.auth.resetPassword, (_e, raw: unknown) => {
    const o = obj(raw, 'auth.resetPassword')
    return resetPassword({
      username: str(o.username, 'username', { max: 100 }),
      recoveryCode: str(o.recoveryCode, 'recoveryCode', { max: 100 }),
      newPassword: str(o.newPassword, 'newPassword', { max: 200 })
    })
  })
}
