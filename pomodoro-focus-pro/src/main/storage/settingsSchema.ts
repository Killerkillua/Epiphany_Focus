import { isAbsolute } from 'node:path'
import { ValidationError } from '../validate'

/**
 * 渲染层可写设置项的逐项校验（H-01 延伸）。
 * 渲染进程是不可信输入源：settings:set 只放行白名单键，并按键校验类型与取值范围，
 * 未知键 / 类型错误 / 越界值一律显式失败，不落盘。
 */

type Validator = (value: unknown, key: string) => unknown

const fail = (key: string, msg: string): never => {
  throw new ValidationError(`设置项 ${key} ${msg}`)
}

const bool: Validator = (v, key) => (typeof v === 'boolean' ? v : fail(key, '必须是布尔值'))

const int =
  (min: number, max: number): Validator =>
  (v, key) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      return fail(key, '必须是整数')
    }
    if (v < min || v > max) return fail(key, `必须在 ${min}–${max} 之间`)
    return v
  }

const oneOf =
  (allowed: readonly string[]): Validator =>
  (v, key) =>
    typeof v === 'string' && allowed.includes(v) ? v : fail(key, `必须是 ${allowed.join('/')} 之一`)

const text =
  (max: number, pattern?: RegExp): Validator =>
  (v, key) => {
    if (typeof v !== 'string') return fail(key, '必须是字符串')
    if (v.length > max) return fail(key, `过长（超过 ${max} 字符）`)
    // 拒绝控制字符
    if (/[\u0000-\u001f\u007f]/.test(v)) return fail(key, '包含非法控制字符')
    if (pattern && !pattern.test(v)) return fail(key, '格式不正确')
    return v
  }

/** 模型名：允许空串（回退默认），否则限制为常见字符集 */
const modelName = text(200, /^[\w./:@+-]*$/)

/** API 端点：必须 https；本机回环地址（本地模型服务）允许 http；禁止内嵌凭据 */
const baseURL: Validator = (v, key) => {
  const s = text(300)(v, key) as string
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return fail(key, '不是有效的 URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    return fail(key, '必须使用 https（仅本机地址允许 http）')
  }
  if (u.username || u.password) return fail(key, '不允许内嵌用户名或密码')
  return s
}

/** API Key：非空、无空白与控制字符 */
const apiKey = text(500, /^\S+$/)

const hhmm: Validator = (v, key) => text(5, /^([01]\d|2[0-3]):[0-5]\d$/)(v, key)

/** 渲染层允许写入的键 → 校验器（白名单） */
export const RENDERER_WRITABLE: Record<string, Validator> = {
  lockLevel: oneOf(['L0', 'L1', 'L2']),
  endAction: oneOf(['lock', 'overlay', 'notify']),
  sessionMaxHours: int(1, 24),
  sessionOverlay: bool,
  'pomodoro.focusMin': int(1, 600),
  'pomodoro.shortBreakMin': int(1, 120),
  'pomodoro.longBreakMin': int(1, 240),
  'pomodoro.longBreakEvery': int(1, 50),
  'bili.strictness': oneOf(['strict', 'standard', 'loose']),
  'bili.autoFullscreen': bool,
  'ai.baseURL': baseURL,
  'ai.apiKey': apiKey,
  'ai.model': modelName,
  'ai.ocrModel': modelName,
  'ai.maxQuestionsPerSession': int(1, 500),
  noisePreset: text(50, /^[\w-]+$/),
  'studyGoals.dailyMinutes': int(0, 1440),
  'studyGoals.weeklyDays': int(0, 7),
  'backup.enabled': bool,
  'backup.frequency': oneOf(['daily', 'weekly']),
  'backup.time': hhmm,
  'backup.keepCount': int(0, 99),
  'backup.directory': (v, key) => {
    const s = text(500)(v, key) as string
    if (s !== '' && !isAbsolute(s)) return fail(key, '必须是绝对路径')
    return s
  },
  telemetryEnabled: bool
}

/** 强制会话进行中禁止修改的键（防止"改设置 → 绕过强制"） */
export const ENFORCED_SESSION_FROZEN = new Set([
  'lockLevel',
  'sessionMaxHours',
  'endAction',
  'bili.strictness'
])

/** 校验单个键值；未知键抛错 */
export function validateRendererSetting(key: string, value: unknown): unknown {
  const validator = Object.prototype.hasOwnProperty.call(RENDERER_WRITABLE, key)
    ? RENDERER_WRITABLE[key]
    : undefined
  if (!validator) throw new ValidationError(`设置项 ${key} 不存在或不允许修改`)
  return validator(value, key)
}
