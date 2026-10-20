/**
 * 任务清单与专注打扰（计划 - 跟踪 - 记录）。
 * 只放纯类型，供主进程、preload 与渲染层共享。
 */

export type TaskPriority = 'high' | 'medium' | 'low'
export type TaskStatus = 'todo' | 'done' | 'archived'
export type TaskSort = 'priority' | 'created' | 'remaining'
export type InterruptionType = 'internal' | 'external'

export interface Task {
  id: string
  title: string
  priority: TaskPriority
  estimatedPomodoros: number
  actualPomodoros: number
  status: TaskStatus
  sortOrder: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface TaskDraft {
  title: string
  priority?: TaskPriority
  estimatedPomodoros?: number
}

export interface TaskPatch {
  title?: string
  priority?: TaskPriority
  estimatedPomodoros?: number
}

export interface TaskFilter {
  /** 缺省为未完成；all 不含归档 */
  status?: TaskStatus | 'all'
  sort?: TaskSort
  keyword?: string
}

export interface InterruptionEvent {
  id: string
  sessionId: number
  taskId: string | null
  type: InterruptionType
  note: string
  elapsedMs: number
  createdAt: number
}

export interface InterruptionAddResult {
  eventId: string
  internalInterruptions: number
  externalInterruptions: number
}

/** 专注质量复盘：原始计数 + 每番茄平均打扰 */
export interface TaskReview {
  todayDone: number
  todoCount: number
  estimatedOpen: number
  actualOpen: number
  internalInterruptions: number
  externalInterruptions: number
  creditedPomodoros: number
  /** 无已结算番茄时为 null */
  avgInterruptionsPerPomo: number | null
  /** 1 / (1 + 每番茄平均打扰)；无数据时为 null */
  quality: number | null
  topInterrupted: Array<{
    taskId: string
    title: string
    interruptions: number
    pomos: number
  }>
}

/** 备份中的专注会话（mode = focus） */
export interface FocusSessionBackup {
  id: number
  taskId: string | null
  level: string
  startedAt: number
  endedAt: number | null
  durationPlanned: number
  durationActual: number
  pomosCompleted: number
  interruptions: number
  internalInterruptions: number
  externalInterruptions: number
  status: string
  pomoCredited: boolean
}
