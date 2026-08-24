/**
 * 渲染层错误消息提取（根因 C 配套）。
 * ipcRenderer.invoke 失败时，Electron 会把主进程抛出的错误包装成：
 *   Error invoking remote method 'ai:english-ask': Error: API Key 无效…
 * 这里剥离包装前缀，保留主进程产出的中文、可操作的核心消息，
 * 避免用户看到难以理解的原始英文包装文本。
 */
export function extractErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const m = raw.match(/Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/)
  const core = (m ? m[1] : raw).trim()
  return core || '请求失败，请稍后重试'
}
