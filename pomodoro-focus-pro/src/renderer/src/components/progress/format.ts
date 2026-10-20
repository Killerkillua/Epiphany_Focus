import type { PlayRecord, PlayStatus } from '../../../../shared/stats'

/** 学习状态展示元信息（标签文案 + antd Tag 颜色） */
export const STATUS_META: Record<PlayStatus, { label: string; color: string }> = {
  planned: { label: '计划中', color: 'default' },
  learning: { label: '学习中', color: 'processing' },
  done: { label: '已学完', color: 'success' }
}

/**
 * 进度页共用格式化 / 计算工具（M1/M2/M3）。
 */

/**
 * 进度百分比（M3 算法）：以最远观看位置 last_position_s 为准，封顶 100%，
 * 不因重复观看（watched_s 累计）而虚高；时长未知（0）视为 0%。
 */
export function recordPercent(rec: PlayRecord): number {
  if (!rec.durationS || rec.durationS <= 0) return 0
  const pos = Math.min(rec.lastPositionS, rec.durationS)
  return Math.min(100, Math.round((pos / rec.durationS) * 100))
}

/** 精读遍数 = 累计观看时长 / 总时长，取整（M3） */
export function roundCount(rec: PlayRecord): number {
  if (!rec.durationS || rec.durationS <= 0 || rec.watchedS <= 0) return 0
  return Math.floor(rec.watchedS / rec.durationS)
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / n 天前 / 日期 */
export function timeAgo(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString()
}

/** 截止日期倒计时（M3）：还剩 X 天 / 今天截止 / 已超期 X 天（红色） */
export function deadlineInfo(deadline: string): { text: string; overdue: boolean } | null {
  if (!deadline) return null
  const target = new Date(`${deadline}T00:00:00`).getTime()
  if (!Number.isFinite(target)) return null
  const days = Math.ceil((target - Date.now()) / 86_400_000)
  if (days > 1) return { text: `还剩 ${days} 天`, overdue: false }
  if (days === 1) return { text: '明天截止', overdue: false }
  if (days === 0) return { text: '今天截止', overdue: false }
  return { text: `已超期 ${-days} 天`, overdue: true }
}

/** 秒 → { h, m, s } */
export function secondsToHMS(total: number): { h: number; m: number; s: number } {
  const t = Math.max(0, Math.floor(total))
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 }
}

/** { h, m, s } → 秒（负值钳制为 0） */
export function hmsToSeconds(h: number, m: number, s: number): number {
  return (
    Math.max(0, Math.floor(h || 0)) * 3600 +
    Math.max(0, Math.floor(m || 0)) * 60 +
    Math.max(0, Math.floor(s || 0))
  )
}

/** 分钟数友好展示：<60 → "x 分钟"；≥60 → "x h y m" */
export function minutesLabel(total: number): string {
  const m = Math.max(0, Math.round(total))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest > 0 ? `${h} h ${rest} m` : `${h} 小时`
}
