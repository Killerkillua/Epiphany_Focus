import type { GrammarPoint, VocabEntry } from './ai'
import type { PlayRecord, StudySession } from './stats'
import type { NoteEntry } from './bili'
import type { FocusSessionBackup, InterruptionEvent, Task } from './task'

/**
 * 数据备份共享类型（M5：本地 JSON 导出 / 导入 / 自动备份）。
 * 独立文件避免 stats ⇄ bili 的循环类型引用。
 */

/** 备份文件格式版本（导出写入 1.2；导入同时接受 1.0 / 1.1） */
export const BACKUP_VERSION = '1.2'
export const BACKUP_VERSIONS = ['1.0', '1.1', '1.2'] as const

/** 备份数据快照（play_records + notes + study_sessions + 标签 + 学习目标） */
export interface BackupFileData {
  playRecords: PlayRecord[]
  notes: NoteEntry[]
  studySessions: StudySession[]
  /** 全部标签（冗余，兼容按标签列表展示） */
  tags: string[]
  /** 全局学习目标（settings.studyGoals 快照） */
  settings: { dailyMinutes: number; weeklyDays: number }
  /** 1.0 备份没有这些字段，导入时按空数组处理 */
  tasks?: Task[]
  focusSessions?: FocusSessionBackup[]
  interruptionEvents?: InterruptionEvent[]
  /** 1.1 及更早没有；导入时按空数组处理。createdAt = vocab.added_at */
  vocab?: VocabEntry[]
  /** 预留：本迭代不采集、不导入 */
  grammarPoints?: GrammarPoint[]
}

/** 备份文件（导出 / 导入的 JSON 结构） */
export interface BackupFile {
  version: string
  exportedAt: number
  data: BackupFileData
}

/** 恢复预览（导入前展示：N 条记录、M 条笔记、导出时间） */
export interface ImportPreview {
  exportedAt: number
  recordCount: number
  noteCount: number
  sessionCount: number
  taskCount?: number
  vocabCount?: number
}

/** 恢复结果计数 */
export interface ImportResult {
  records: number
  notes: number
  sessions: number
  tasks?: number
  vocab?: number
}

/** 备份元数据（backup_meta 表行） */
export interface BackupMeta {
  id: number
  filePath: string
  fileSize: number
  recordCount: number
  /** manual = 手动备份；auto = 自动备份 */
  backupType: 'manual' | 'auto'
  createdAt: number
}
