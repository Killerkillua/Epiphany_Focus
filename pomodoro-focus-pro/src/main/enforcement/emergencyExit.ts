import bcrypt from 'bcryptjs'
import { getSettings, setSettings } from '../storage/settings'
import type { EmergencyExitResult, EmergencyGuardState } from '../../shared/settings'

/**
 * 紧急退出机制（方案 2.10）：
 * - 恢复码 bcrypt 哈希存储（首次强制设置，至少 8 位且需满足基本复杂度）
 * - 连按 5 次 Esc 由渲染层检测后调 emergency:exit 验证
 * - 每错 3 次锁定一轮，锁定时长指数退避：1min → 2min → 4min …（上限 6h），验证成功清零
 * - 失败计数 / 锁定截止 / L2 冷却全部持久化（签名存储 guard.json），杀进程重启不清零；
 *   且在 bcrypt 比对「之前」落盘，无法靠比对中途杀进程来免计数
 * - L2 额外 30 秒冷却
 * - 会话时长上限默认 4h，超限自动解除
 *
 * 注意：这是"自律辅助"而非安全边界，威胁模型见 README。
 */

const MAX_FAILS = 3
const BASE_LOCK_MS = 60_000
const MAX_LOCK_MS = 6 * 3_600_000
const L2_COOLDOWN_MS = 30_000
export const MIN_CODE_LENGTH = 8

const EMPTY_GUARD: EmergencyGuardState = {
  failCount: 0,
  failLockedUntil: 0,
  lockoutStrikes: 0,
  l2CoolDownUntil: 0
}

function loadGuard(): EmergencyGuardState {
  return { ...EMPTY_GUARD, ...(getSettings().emergencyGuard ?? {}) }
}

function saveGuard(g: EmergencyGuardState): void {
  setSettings({ emergencyGuard: g })
}

/** 第 n 轮锁定时长（n 从 0 起）：60s * 2^n，封顶 6h */
export function lockDurationMs(strikes: number): number {
  return Math.min(BASE_LOCK_MS * 2 ** Math.max(0, strikes), MAX_LOCK_MS)
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000)
  return sec >= 3600 ? `${Math.round(sec / 360) / 10} 小时` : sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`
}

export function hasRecoveryCode(): boolean {
  return !!getSettings().recoveryCodeHash
}

/**
 * bcrypt 的 cost factor。使用异步 API（bcrypt.hash/compare）以避免在 Electron
 * 主进程事件循环上同步阻塞 50-100ms（H-02：阻塞期间 UI 冻结、IPC 排队）。
 */
const BCRYPT_ROUNDS = 10

/** 恢复码强度校验：≥8 位、非单一重复字符、至少含 2 类字符（小写/大写/数字/符号） */
export function validateRecoveryCode(code: string): string | null {
  if (!code || code.length < MIN_CODE_LENGTH) return `恢复码至少 ${MIN_CODE_LENGTH} 位`
  if (new Set(code).size === 1) return '恢复码不能是单一重复字符'
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(code)).length
  if (classes < 2) return '恢复码需至少包含两类字符（大小写字母 / 数字 / 符号）'
  return null
}

export async function setRecoveryCode(code: string): Promise<void> {
  const problem = validateRecoveryCode(code)
  if (problem) throw new Error(problem)
  const hash = await bcrypt.hash(code, BCRYPT_ROUNDS)
  setSettings({ recoveryCodeHash: hash })
}

/**
 * 旧恢复码比对（纯比对，不触发失败计数 / 冷却）。
 * 修改已有恢复码的身份校验已改为当前账户密码（见 enforcement.setCode）；
 * 未设置过恢复码时返回 true。
 */
export async function verifyOldCode(code: string): Promise<boolean> {
  const hash = getSettings().recoveryCodeHash
  if (!hash) return true
  return !!code && (await bcrypt.compare(code, hash))
}

/** L2 额外 30s 冷却（会话开始/结束时由 enforcement 触发，持久化） */
export function startL2CoolDown(): void {
  saveGuard({ ...loadGuard(), l2CoolDownUntil: Date.now() + L2_COOLDOWN_MS })
}

/** 串行化验证：并发请求不能读到同一份旧计数 */
let verifyChain: Promise<unknown> = Promise.resolve()

export function verifyRecoveryCode(code: string, level: string): Promise<EmergencyExitResult> {
  const run = verifyChain.then(() => doVerify(code, level))
  verifyChain = run.catch(() => undefined)
  return run
}

async function doVerify(code: string, _level: string): Promise<EmergencyExitResult> {
  const now = Date.now()
  const g = loadGuard()

  if (now < g.failLockedUntil) {
    return {
      ok: false,
      error: '尝试次数过多，请稍后再试',
      retryInSec: Math.ceil((g.failLockedUntil - now) / 1000)
    }
  }
  if (now < g.l2CoolDownUntil) {
    return {
      ok: false,
      error: `L2 冷却中，请等待 ${L2_COOLDOWN_MS / 1000} 秒`,
      retryInSec: Math.ceil((g.l2CoolDownUntil - now) / 1000)
    }
  }

  const hash = getSettings().recoveryCodeHash
  if (!hash) {
    return { ok: false, error: '尚未设置紧急恢复码，请在设置中先设置' }
  }

  // 先记失败再比对：比对期间被杀进程也算一次失败
  const failCount = g.failCount + 1
  let next: EmergencyGuardState
  let lockMs = 0
  if (failCount >= MAX_FAILS) {
    lockMs = lockDurationMs(g.lockoutStrikes)
    next = {
      ...g,
      failCount: 0,
      failLockedUntil: now + lockMs,
      lockoutStrikes: g.lockoutStrikes + 1
    }
  } else {
    next = { ...g, failCount }
  }
  saveGuard(next)

  if (await bcrypt.compare(code ?? '', hash)) {
    saveGuard({ ...EMPTY_GUARD, l2CoolDownUntil: g.l2CoolDownUntil })
    return { ok: true }
  }

  if (lockMs > 0) {
    return {
      ok: false,
      error: `恢复码错误已达 ${MAX_FAILS} 次，已锁定 ${formatDuration(lockMs)}`,
      retryInSec: Math.ceil(lockMs / 1000)
    }
  }
  return { ok: false, error: `恢复码错误（还可尝试 ${MAX_FAILS - failCount} 次）` }
}

/** 会话是否超时（默认上限 4h） */
export function isSessionExpired(startedAt: number): boolean {
  const maxMs = getSettings().sessionMaxHours * 3_600_000
  return Date.now() - startedAt > maxMs
}

/** 会话开始时校验前置条件（L1/L2 必须已设置恢复码） */
export function assertExitSafety(level: string): void {
  if (level !== 'L0' && !hasRecoveryCode()) {
    throw new Error(`请先在设置中设置紧急恢复码（至少 ${MIN_CODE_LENGTH} 位），再开始强制会话`)
  }
}
