/** 崩溃上报载荷（渲染层 → 主进程 crash:report-renderer） */
export interface CrashReportPayload {
  kind: string
  message: string
  stack?: string
  source?: string
}

export interface DiagnosticExportResult {
  ok: boolean
  canceled?: boolean
  filePath?: string
  error?: string
}
