import bcrypt from 'bcryptjs'
import { getSettings, setSettings } from '../storage/settings'
import type { EmergencyExitResult } from '../../shared/settings'

/**
 * 紧急退出机制（方案 2.10）：
 * - 恢复码 bcrypt 哈希存储（首次强制设置，至少 6 位）
 * - 连按 5 次 Esc 由渲染层检测后调 emergency:exit 验证
 * - 错 3 次冷却 1 分钟；L2 额外 30 秒冷却
 * - 会话时长上限默认 4h，超限自动解除
 */

const MAX_FAILS = 3
const FAIL_COOLDOWN_MS = 60_000
const L2_COOLDOWN_MS = 30_000
const MIN_CODE_LENGTH = 6

let failCount = 0
let failLockedUntil = 0
let l2CoolDownUntil = 0

export function hasRecoveryCode(): boolean {
  return !!getSettings().recoveryCodeHash
}

/**
 * bcrypt 的 cost factor。使用异步 API（bcrypt.hash/compare）以避免在 Electron
 * 主进程事件循环上同步阻塞 50-100ms（H-02：阻塞期间 UI 冻结、IPC 排队）。
 */
const BCRYPT_ROUNDS = 10

export async function setRecoveryCode(code: string): Promise<void> {
  if (!code || code.length < MIN_CODE_LENGTH) {
    throw new Error(`恢复码至少 ${MIN_CODE_LENGTH} 位`)
  }
  const hash = await bcrypt.hash(code, BCRYPT_ROUNDS)
  setSettings({ recoveryCodeHash: hash })
}

/**
 * 修改恢复码前的旧码校验（CR-02）。
 * 纯比对，不触发失败计数 / 冷却（区别于 verifyRecoveryCode 的紧急退出路径）。
 * 未设置过恢复码时返回 true（首次设置无需旧码）。
 */
export async function verifyOldCode(code: string): Promise<boolean> {
  const hash = getSettings().recoveryCodeHash
  if (!hash) return true
  return !!code && (await bcrypt.compare(code, hash))
}

/** L2 额外 30s 冷却（会话开始/结束时由 enforcement 触发） */
export function startL2CoolDown(): void {
  l2CoolDownUntil = Date.now() + L2_COOLDOWN_MS
}

export async function verifyRecoveryCode(
  code: string,
  level: string
): Promise<EmergencyExitResult> {
  const now = Date.now()
  if (now < failLockedUntil) {
    return {
      ok: false,
      error: '尝试次数过多，请稍后再试',
      retryInSec: Math.ceil((failLockedUntil - now) / 1000)
    }
  }
  if (now < l2CoolDownUntil) {
    return {
      ok: false,
      error: `L2 冷却中，请等待 ${L2_COOLDOWN_MS / 1000} 秒`,
      retryInSec: Math.ceil((l2CoolDownUntil - now) / 1000)
    }
  }

  const hash = getSettings().recoveryCodeHash
  if (!hash) {
    return { ok: false, error: '尚未设置紧急恢复码，请在设置中先设置' }
  }

  if (await bcrypt.compare(code ?? '', hash)) {
    failCount = 0
    return { ok: true }
  }

  failCount += 1
  if (failCount >= MAX_FAILS) {
    failCount = 0
    failLockedUntil = now + FAIL_COOLDOWN_MS
    return { ok: false, error: '恢复码错误已达 3 次，已锁定 1 分钟', retryInSec: 60 }
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
    throw new Error('请先在设置中设置紧急恢复码（至少 6 位），再开始强制会话')
  }
}
