/**
 * 账号体系共享类型与校验规则（主进程 / 渲染层共用，纯函数无运行时依赖）。
 * 账号为纯本地账号：每个账号一个独立 SQLite 数据文件，账号表存于 auth.db。
 */

export interface AuthUser {
  id: number
  username: string
  nickname: string
}

export type AuthState =
  | { status: 'loggedOut' }
  | { status: 'guest' }
  | { status: 'user'; user: AuthUser }

/** 统一结果：失败带可读错误，锁定时带剩余秒数 */
export type AuthFail = { ok: false; error: string; retryInSec?: number }
export type AuthOk<T = void> = T extends void ? { ok: true } : { ok: true } & T
export type AuthResult<T = void> = AuthOk<T> | AuthFail

export interface RegisterPayload {
  username: string
  password: string
  nickname?: string
}

export interface LoginPayload {
  username: string
  password: string
  /** 记住我（自动登录，30 天） */
  remember: boolean
}

export interface ResetPasswordPayload {
  username: string
  recoveryCode: string
  newPassword: string
}

export interface DeleteAccountPayload {
  password: string
  /** 是否同时删除该账号的全部本地数据 */
  deleteData: boolean
}

export const AUTH_RULES = {
  usernameMin: 3,
  usernameMax: 20,
  passwordMin: 8,
  passwordMax: 64,
  nicknameMax: 20,
  /** 连续失败多少次触发锁定 */
  maxFailures: 5,
  /** 首次锁定秒数（之后每再失败一轮翻倍，上限 1 小时） */
  lockBaseSec: 300,
  lockMaxSec: 3600,
  /** 自动登录有效期（毫秒） */
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000
} as const

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]+$/

/** 返回错误文案；合法返回 null */
export function validateUsername(username: string): string | null {
  const v = username.trim()
  if (v.length < AUTH_RULES.usernameMin || v.length > AUTH_RULES.usernameMax) {
    return `用户名需 ${AUTH_RULES.usernameMin}–${AUTH_RULES.usernameMax} 个字符`
  }
  if (!USERNAME_RE.test(v)) return '用户名仅支持中文、字母、数字和下划线'
  return null
}

export function validatePassword(password: string): string | null {
  if (password.length < AUTH_RULES.passwordMin) return `密码至少 ${AUTH_RULES.passwordMin} 位`
  if (password.length > AUTH_RULES.passwordMax) return `密码最多 ${AUTH_RULES.passwordMax} 位`
  // bcrypt 只取前 72 字节，超出会被静默截断
  if (new TextEncoder().encode(password).length > 72) return '密码过长（不超过 72 字节）'
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码需同时包含字母和数字'
  return null
}

export function validateNickname(nickname: string): string | null {
  if (nickname.trim().length > AUTH_RULES.nicknameMax) {
    return `昵称最多 ${AUTH_RULES.nicknameMax} 个字符`
  }
  return null
}

/** 密码强度 0–4（仅用于界面强度条） */
export function passwordStrength(password: string): number {
  let s = 0
  if (password.length >= 8) s++
  if (password.length >= 12) s++
  if (/[A-Za-z]/.test(password) && /\d/.test(password)) s++
  if (/[^A-Za-z0-9]/.test(password) || (/[a-z]/.test(password) && /[A-Z]/.test(password))) s++
  return s
}
