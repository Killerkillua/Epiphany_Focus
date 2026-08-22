/**
 * IPC 参数运行时校验（H-01）。
 * TypeScript 类型在运行时被完全擦除，渲染进程是不可信输入源（一旦被 XSS 攻破，
 * 攻击者不受 TS 约束）。此模块提供一组零依赖的运行时守卫，在 IPC 边界处校验参数，
 * 避免畸形数据（null / 错误类型 / 超长字符串 / 结构缺失）直达业务逻辑。
 * 约定：校验失败抛错（错误带通道名，便于排查），由 IPC 层统一转成错误响应。
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** 各字段通用上限，防超长输入拖垮主进程 */
export const LIMITS = {
  /** 普通字符串最大长度 */
  string: 20_000,
  /** AI 提问/笔记等长文本最大长度 */
  longString: 200_000,
  /** 数组最大长度 */
  array: 10_000,
  /** 历史消息轮数上限 */
  historyTurns: 50
} as const

export interface StrOpts {
  /** 最大长度（默认 LIMITS.string） */
  max?: number
  /** 允许空字符串 */
  allowEmpty?: boolean
  /** 允许 undefined（可选字段） */
  optional?: boolean
}

/** 校验字符串（含可选与长度限制） */
export function str(value: unknown, label: string, opts: StrOpts = {}): string {
  if (value === undefined && opts.optional) return undefined as unknown as string
  if (typeof value !== 'string') throw new ValidationError(`${label} 必须是字符串`)
  const max = opts.max ?? LIMITS.string
  if (!opts.allowEmpty && value.length === 0) throw new ValidationError(`${label} 不能为空`)
  if (value.length > max) throw new ValidationError(`${label} 过长（超过 ${max} 字符）`)
  return value
}

/** 校验可选字符串（undefined 或符合 str 规则） */
export function optStr(value: unknown, label: string, opts: StrOpts = {}): string | undefined {
  if (value === undefined) return undefined
  return str(value, label, opts)
}

/** 校验有限数字 */
export function num(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${label} 必须是有限数字`)
  }
  return value
}

/** 校验可选的有限数字 */
export function optNum(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  return num(value, label)
}

/** 校验布尔值 */
export function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${label} 必须是布尔值`)
  return value
}

/** 校验可选布尔值 */
export function optBool(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  return bool(value, label)
}

export interface ArrOpts {
  max?: number
  optional?: boolean
  /** 每项必须是字符串 */
  itemString?: boolean
}

/** 校验数组（可选） */
export function arr(value: unknown, label: string, opts: ArrOpts = {}): unknown[] {
  if (value === undefined && opts.optional) return undefined as unknown as unknown[]
  if (!Array.isArray(value)) throw new ValidationError(`${label} 必须是数组`)
  const max = opts.max ?? LIMITS.array
  if (value.length > max) throw new ValidationError(`${label} 过长（超过 ${max} 项）`)
  if (opts.itemString) {
    for (const item of value) {
      if (typeof item !== 'string') throw new ValidationError(`${label} 必须全部是字符串`)
    }
  }
  return value
}

/** 校验数组（必填） */
export function arrOf(value: unknown, label: string, opts: ArrOpts = {}): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} 必须是数组`)
  return arr(value, label, opts)
}

/** 校验普通对象（不含 null / 数组） */
export function obj(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

/** 校验可选对象 */
export function optObj(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return obj(value, label)
}

/** 校验白名单枚举值（undefined 或属于合法值集合） */
export function oneOf<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
  optional = false
): T | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${label} 必须是 ${allowed.join(' / ')} 之一`)
  }
  return value as T
}

/** 兜底：确保入参是对象（拒绝 null/primitive），并把畸形参数归一为安全空对象 */
export function safeRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
