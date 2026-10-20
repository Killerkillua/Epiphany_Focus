/**
 * AI 网关错误分类（根因 C 修复）。
 * OpenAI SDK / 网络层异常 → 中文、可操作、指明「设置 → AI 设置」的错误消息。
 * 约束：所有新增错误消息必须是中文、可操作、指明设置页路径。
 */

interface HttpLikeError {
  status?: number
  message?: string
  code?: string
}

/** 网络层错误特征（OpenAI SDK 底层 fetch 抛出的 message / code） */
const NETWORK_PATTERNS =
  /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|Network Error|getaddrinfo/i

/**
 * 把任意 AI 调用异常翻译为面向用户的友好错误。
 * - HTTP 401/403：Key 无效或与端点不匹配 → 指向「设置 → AI 设置」
 * - HTTP 404：模型/端点不存在 → 指向「设置 → AI 设置」
 * - HTTP 429：限流 → 稍后重试
 * - HTTP 5xx：服务端故障 → 稍后重试 + 检查端点
 * - 网络层错误：无法连接 → 检查网络与端点
 * - 其它：保留原始细节并附设置页指引
 */
export class AiAbortedError extends Error {
  constructor() {
    super('已取消')
    this.name = 'AiAbortedError'
  }
}

export function isAiAborted(err: unknown): boolean {
  if (err instanceof AiAbortedError) return true
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'APIUserAbortError'
}

/** 429、5xx 和网络中断可以重试；鉴权与模型不存在不重试。 */
export function isRetryableAiError(err: unknown): boolean {
  if (isAiAborted(err)) return false
  const raw = (err ?? {}) as HttpLikeError
  const status = typeof raw.status === 'number' ? raw.status : undefined
  if (status === 401 || status === 403 || status === 404) return false
  if (status === 429 || (status !== undefined && status >= 500)) return true
  const detail = typeof raw.message === 'string' ? raw.message : String(err)
  return NETWORK_PATTERNS.test(detail)
}

/** 429 优先遵守 Retry-After，上限 30 秒；否则 1s / 2s / 4s。测试里不等待。 */
export function aiRetryDelayMs(err: unknown, attempt: number): number {
  const headers = (err as { headers?: { get?: (name: string) => string | null } | Record<string, string> })
    .headers
  let retryAfter = ''
  if (headers && typeof headers.get === 'function') retryAfter = headers.get('retry-after') ?? ''
  else if (headers && typeof headers === 'object') {
    retryAfter = String((headers as Record<string, string>)['retry-after'] ?? '')
  }
  const seconds = Number(retryAfter)
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt
  const capped = Math.min(30_000, Math.max(0, ms))
  return process.env.VITEST ? 0 : capped
}

export async function waitForAiRetry(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function toFriendlyAiError(err: unknown): Error {
  const raw = (err ?? {}) as HttpLikeError
  const status = typeof raw.status === 'number' ? raw.status : undefined
  const detail = typeof raw.message === 'string' ? raw.message : String(err)

  if (status === 401 || status === 403) {
    return new Error(
      `API Key 无效或已被撤销（HTTP ${status}）。请到「设置 → AI 设置」重新填写正确的 API Key，并确认 API 端点与 Key 属于同一服务商（如硅基流动的 Key 需搭配硅基流动端点）后重试。`
    )
  }
  if (status === 404) {
    return new Error(
      `模型或 API 端点不存在（HTTP 404）。请到「设置 → AI 设置」检查「API 端点」与「对话模型」填写是否正确后重试。`
    )
  }
  if (status === 429) {
    return new Error(
      '请求过于频繁（HTTP 429，已达服务商限流或额度上限）。请稍后重试；若持续出现，可到「设置 → AI 设置」检查服务商额度或更换模型后重试。'
    )
  }
  if (status !== undefined && status >= 500) {
    return new Error(
      `AI 服务暂时不可用（HTTP ${status}），请稍后重试；若持续失败，请到「设置 → AI 设置」检查 API 端点配置。`
    )
  }
  if (NETWORK_PATTERNS.test(detail)) {
    return new Error(
      '无法连接 AI 服务（网络错误）。请检查网络连接，并确认「设置 → AI 设置」中的 API 端点可访问后重试。'
    )
  }
  return new Error(`AI 服务调用失败：${detail}（请到「设置 → AI 设置」检查配置后重试）`)
}
