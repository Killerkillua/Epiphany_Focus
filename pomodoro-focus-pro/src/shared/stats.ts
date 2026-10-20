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

/** 统计页视频学习复盘（全表聚合，不依赖被截断的列表） */
export interface StudyReviewTotals {
  watchedMinutes: number
  doneCount: number
  learningCount: number
  noteCount: number
  keyCount: number
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
  /** 累计已观看时长（秒，会话级撮合，非逐帧跟踪；用于学习时长统计与"看过几遍"） */
  watchedS: number
  /** 最近一次离开时的播放位置（秒；进度百分比以此为准，避免重复观看虚高） */
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
  /** 用户手动打的标签（play_record_tags 关联表聚合；M1 筛选维度） */
  tags: string[]
  /** 视频封面图 URL（bili-image:// 代理地址，记录卡片封面） */
  coverUrl: string
  /** UP 主名称 */
  author: string
  /** 稳定资源键。旧记录可能为空，读取时由 bvid 补齐 */
  resourceKey?: string
  resourceType?: 'bili' | 'local' | 'web'
  /** 仅网站记录回传规范化 URL。本地路径留在主进程，不发给渲染层 */
  sourceUri?: string
}

/** 学习记录可修改字段（play-records:update / 「调整进度」对话框；M1） */
export interface PlayRecordUpdate {
  title?: string
  /** 视频总时长（秒） */
  durationS?: number
  /** 已观看时长（秒） */
  watchedS?: number
  /** 上次播放位置（秒） */
  lastPositionS?: number
  /** 学习状态 */
  status?: PlayStatus
  /** 观看次数 */
  viewedCount?: number
  /** 目标精读遍数（0 = 清除） */
  goalRounds?: number
  /** 目标截止日期（YYYY-MM-DD，空 = 清除） */
  goalDeadline?: string
  coverUrl?: string
  author?: string
}

/** 学习会话来源（study_sessions.source） */
export type SessionSource = 'manual' | 'resume' | 'search'

/** 学习会话明细（study_sessions：一次打开视频 → 关闭视频，M3） */
export interface StudySession {
  id: number
  bvid: string
  /** 会话开始时间戳（ms） */
  startAt: number
  /** 会话结束时间戳（ms；0 = 进行中） */
  endAt: number
  /** 有效学习时长（秒；本期取窗口打开墙钟时长，精度依赖会话心跳） */
  durationS: number
  /** 来源：manual / resume（续学）/ search（搜索结果） */
  source: SessionSource
  createdAt: number
}

/** 进度页筛选条件（M1：多维度筛选 + 排序） */
export interface ProgressFilter {
  /** 标题关键词模糊匹配 */
  keyword?: string
  /** 学习状态；'all' = 不过滤 */
  status?: PlayStatus | 'all'
  /** 标签多选（至少命中其一） */
  tags?: string[]
  /** 更新时间范围（ms 时间戳） */
  dateRange?: { start: number; end: number } | null
  sortBy: 'updated_at' | 'progress' | 'duration' | 'title'
  sortOrder: 'asc' | 'desc'
}

/** 每日学习时长点（近 N 天，无数据日补 0；M4 柱状图数据源） */
export interface DailyStat {
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 当日学习分钟数 */
  minutes: number
}

/** 进度页概览统计（M3：play_records + study_sessions 聚合） */
export interface ProgressStats {
  /** 今日学习时长（分钟） */
  todayMinutes: number
  /** 本周（近 7 天）学习时长（分钟） */
  weekMinutes: number
  /** 本月学习时长（分钟） */
  monthMinutes: number
  /** 连续学习天数（今天未学则从昨天起算） */
  streakDays: number
  /** 本周已学习天数（近 7 天内有 ≥1 分钟会话的天数，周目标进度用） */
  weekDaysStudied: number
  /** 总课程数 */
  totalCourses: number
  /** 已完成课程数 */
  doneCourses: number
  /** 学习中课程数 */
  learningCourses: number
  /** 待学课程数 */
  plannedCourses: number
  /** 全局每日学习目标（分钟，0 = 未设定；settings.studyGoals） */
  dailyGoalMinutes: number
  /** 全局每周学习天数目标（0 = 未设定；settings.studyGoals） */
  weeklyGoalDays: number
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
  '卡顿' | '遮不住视频' | '退出不便' | '笔记丢失' | 'AI 回答质量' | '其他'

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
