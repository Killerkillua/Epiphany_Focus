/**
 * 学习统计共享类型（从 study_stats / sessions 聚合）。
 */

/** 日趋势点（study_stats 按 date 聚合） */
export interface DayTrendPoint {
  date: string
  minutes: number
  pomos: number
}

/** 模式对比（study_stats 按 mode 聚合） */
export interface ModeStat {
  mode: string
  minutes: number
  pomos: number
}

/** 时段热力图单元（sessions 按 星期 × 小时 聚合，时段热力图 7×24） */
export interface HeatmapCell {
  /** 0=周日 … 6=周六 */
  weekday: number
  /** 0-23 */
  hour: number
  minutes: number
  sessions: number
}

/** 首页聚合汇总（今日专注 / 完成番茄 / 连续天数） */
export interface HomeSummary {
  /** 今日累计专注分钟（study_stats 按 date 聚合） */
  todayMinutes: number
  /** 今日完成番茄数 */
  todayPomos: number
  /** 当前连续学习天数（今天未学则从昨天起算，今天仍计入） */
  streakDays: number
}
