/** 会话统计与番茄历史的导出格式 */
export type StatsExportFormat = 'csv' | 'xlsx'

/** 生词本导出格式 */
export type VocabExportFormat = 'apkg' | 'txt'

/** 主进程写盘后返回给渲染层的结果（取消不算失败） */
export interface ExportFileResult {
  ok: boolean
  canceled?: boolean
  filePath?: string
  error?: string
}
