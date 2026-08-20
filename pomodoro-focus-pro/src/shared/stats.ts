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

/* ===== 按视频学习进度（play_records，F-3） ===== */

/** 学习状态：计划 / 学习中 / 已学完 */
export type PlayStatus = 'planned' | 'learning' | 'done'

/** 单条视频的学习进度记录 */
export interface PlayRecord {
  /** BV 号（主键） */
  bvid: string
  /** 视频标题快照 */
  title: string
  /** 视频总时长（秒，0 = 未知） */
  durationS: number
  /** 累计已观看时长（秒，会话级撮合，非逐帧跟踪） */
  watchedS: number
  /** 最近一次离开时的播放位置（秒） */
  lastPositionS: number
  /** 学习状态 */
  status: PlayStatus
  /** 累计打开/观看次数 */
  viewedCount: number
  /** 学习目标（F-5）：目标精读遍数，0 = 未设定 */
  goalRounds: number
  /** 目标截止日期（YYYY-MM-DD，空 = 未设定） */
  goalDeadline: string
  createdAt: number
  updatedAt: number
}

/** 学习进度心跳（renderer → 主进程，会话级撮合） */
export interface PlayRecordTick {
  bvid: string
  title?: string
  durationS?: number
  /** 本次心跳新增观看秒数（≥0） */
  watchedDeltaS: number
  /** 当前播放位置秒（最近一次离开位置） */
  positionS: number
}

/* ===== 用户反馈（feedback，R-1） ===== */

/** 反馈分类（与反馈弹窗选项一致） */
export type FeedbackCategory =
  | '卡顿'
  | '遮不住视频'
  | '退出不便'
  | '笔记丢失'
  | 'AI 回答质量'
  | '其他'

export interface FeedbackEntry {
  id: number
  /** 反馈来源模式：bili / english / focus / 通用 */
  mode: string
  /** 满意度打分 1-5（★） */
  rating: number
  category: FeedbackCategory | ''
  detail: string
  createdAt: number
}

export interface FeedbackStats {
  count: number
  /** 平均分（0 = 无数据） */
  avgRating: number
  /** 分类计数 */
  byCategory: Record<string, number>
}
