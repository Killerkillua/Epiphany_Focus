import { describe, expect, it } from 'vitest'
import { aiRetryDelayMs, isRetryableAiError } from './errors'

describe('AI 错误是否可重试', () => {
  it('429 和网络错误可重试，401/403/404 不重试', () => {
    expect(isRetryableAiError(Object.assign(new Error('limited'), { status: 429 }))).toBe(true)
    expect(isRetryableAiError(Object.assign(new Error('down'), { status: 503 }))).toBe(true)
    expect(isRetryableAiError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableAiError(Object.assign(new Error('bad key'), { status: 401 }))).toBe(false)
    expect(isRetryableAiError(Object.assign(new Error('forbidden'), { status: 403 }))).toBe(false)
    expect(isRetryableAiError(Object.assign(new Error('missing'), { status: 404 }))).toBe(false)
    expect(isRetryableAiError(Object.assign(new Error('stop'), { name: 'AbortError' }))).toBe(false)
  })

  it('429 遵守 Retry-After 且不超过 30 秒，否则按 1s / 2s / 4s', () => {
    const prev = process.env.VITEST
    delete process.env.VITEST
    try {
      expect(aiRetryDelayMs({ headers: { get: () => '5' } }, 0)).toBe(5000)
      expect(aiRetryDelayMs({ headers: { get: () => '120' } }, 0)).toBe(30_000)
      expect(aiRetryDelayMs({}, 0)).toBe(1000)
      expect(aiRetryDelayMs({}, 1)).toBe(2000)
      expect(aiRetryDelayMs({}, 2)).toBe(4000)
    } finally {
      if (prev === undefined) delete process.env.VITEST
      else process.env.VITEST = prev
    }
  })
})
