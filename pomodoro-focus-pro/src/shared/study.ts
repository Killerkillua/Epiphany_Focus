/**
 * 通用学习资源契约（B 站 / 本地视频 / 白名单网站）。
 * 纯类型与纯函数，供主进程、preload 与渲染层共用。
 */

export type StudyResourceKind = 'bili' | 'local' | 'web'

/** 稳定资源键：bili:BV… / local:<fingerprint> / web:<hash> */
export type StudyResourceKey = string

export interface StudyResource {
  resourceKey: StudyResourceKey
  kind: StudyResourceKind
  /** play_records / notes 使用的记录 id。B 站仍为原始 BV，以兼容旧数据 */
  recordId: string
  title: string
  topic?: string
}

export interface StudyContext {
  resourceKey: StudyResourceKey
  kind: StudyResourceKind
  recordId: string
  topic?: string
  title?: string
  fullscreen: boolean
  /** 网站无可读 video 元素时为 false，笔记仍可保存但不带时间点 */
  canSeek: boolean
}

export interface LearningSiteRule {
  id: string
  /** 规范化主机名（ASCII / punycode，不含端口与协议） */
  host: string
  includeSubdomains: boolean
  /** 空数组表示放行该主机的全部路径 */
  pathPrefixes: string[]
  enabled: boolean
  label: string
}

export interface OpenLocalStudyPayload {
  autoFullscreen: boolean
  topic?: string
  plannedMs?: number
  seekSeconds?: number
}

export interface OpenWebStudyPayload {
  url: string
  autoFullscreen: boolean
  topic?: string
  plannedMs?: number
  /** 用户给站点起的别名，标题提取失败时使用 */
  label?: string
}

export interface SiteRulePreview {
  ok: boolean
  summary: string
  error?: string
  rule?: LearningSiteRule
}

export interface LocalMediaPickResult {
  canceled: boolean
  resourceKey?: string
  title?: string
  extension?: string
  /** mkv/flv 等 Chromium 通常无法直接播放 */
  unreliable?: boolean
  warning?: string
}

const LOCAL_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.flv', '.m4v', '.mov'])
export const UNRELIABLE_MEDIA_EXTENSIONS = new Set(['.mkv', '.flv'])

export function mediaExtension(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = slash >= 0 ? name.slice(slash + 1) : name
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

export function isSelectableMediaName(name: string): boolean {
  return LOCAL_EXTENSIONS.has(mediaExtension(name))
}

export function biliResourceKey(bvid: string): string {
  return bvid.startsWith('bili:') ? bvid : `bili:${bvid}`
}

export function resourceKindOf(key: string): StudyResourceKind | null {
  if (key.startsWith('bili:') || /^BV/i.test(key)) return 'bili'
  if (key.startsWith('local:')) return 'local'
  if (key.startsWith('web:')) return 'web'
  return null
}

/** 旧 bvid 列与新资源键互转。B 站记录继续用原始 BV 作为主键。 */
export function recordIdFromResourceKey(resourceKey: string): string {
  if (resourceKey.startsWith('bili:')) return resourceKey.slice('bili:'.length)
  return resourceKey
}

export function resourceKeyFromRecordId(recordId: string): string {
  if (!recordId) return ''
  if (
    recordId.startsWith('bili:') ||
    recordId.startsWith('local:') ||
    recordId.startsWith('web:')
  ) {
    return recordId
  }
  return biliResourceKey(recordId)
}

/** 稳定短哈希（FNV-1a 双路），避免渲染层依赖 Node crypto。 */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= input.charCodeAt(input.length - 1 - i)
    h2 = Math.imul(h2, 0x01000193)
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
  return hex(h1) + hex(h2)
}

export function webResourceKey(canonicalUrl: string): string {
  return `web:${stableHash(canonicalUrl)}`
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export type UrlNormalizeResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

/** 学习网站只接受 https；本机回环允许 http。拒绝 userinfo 与非网页协议。 */
export function normalizeLearningUrl(raw: string): UrlNormalizeResult {
  const text = raw.trim()
  if (!text) return { ok: false, reason: '网址不能为空' }
  let url: URL
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`)
  } catch {
    return { ok: false, reason: '不是有效的网址' }
  }
  if (url.username || url.password) return { ok: false, reason: '不允许在网址中包含账号或密码' }
  const loopback = LOOPBACK.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, reason: '学习网站只允许 https（本机地址允许 http）' }
  }
  if (url.port && url.port !== '443' && url.port !== '80') {
    return { ok: false, reason: '只允许默认端口（https 443 / http 80）' }
  }
  return { ok: true, url }
}

export function canonicalWebUrl(url: URL): string {
  const path = url.pathname || '/'
  return `${url.origin}${path}${url.search}`
}

export function hostMatches(hostname: string, rule: Pick<LearningSiteRule, 'host' | 'includeSubdomains'>): boolean {
  const host = hostname.toLowerCase()
  const base = rule.host.toLowerCase()
  if (host === base) return true
  return rule.includeSubdomains && host.endsWith(`.${base}`)
}

export function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  const raw = prefix.startsWith('/') ? prefix : `/${prefix}`
  const normalized = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

export function pathAllowed(pathname: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true
  return prefixes.some((prefix) => pathMatchesPrefix(pathname, prefix))
}

export function matchSiteRule(url: URL, rules: LearningSiteRule[]): LearningSiteRule | null {
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!hostMatches(url.hostname, rule)) continue
    if (!pathAllowed(url.pathname || '/', rule.pathPrefixes)) continue
    return rule
  }
  return null
}

function cleanPathPrefix(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const withSlash = text.startsWith('/') ? text : `/${text}`
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(withSlash)) return null
  if (withSlash.includes('..')) return null
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

export function parseHostInput(raw: string): { host: string; includeSubdomains: boolean } | { error: string } {
  const text = raw.trim().toLowerCase()
  if (!text) return { error: '域名不能为空' }
  let host = text
  let includeSubdomains = true
  if (host.startsWith('*.')) {
    host = host.slice(2)
    includeSubdomains = true
  }
  if (host.includes('://') || host.includes('/')) {
    const normalized = normalizeLearningUrl(text.startsWith('*.') ? `https://${host}` : raw)
    if (!normalized.ok) return { error: normalized.reason }
    host = normalized.url.hostname
  }
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    return { error: '域名格式不正确' }
  }
  if (host.startsWith('www.') && !raw.trim().startsWith('*.')) {
    // 用户显式输入 www 时只匹配该主机，避免意外放行整站其它子域
    includeSubdomains = raw.trim().startsWith('*.')
  }
  return { host, includeSubdomains }
}

export function describeSiteRule(rule: LearningSiteRule): string {
  const scope = rule.includeSubdomains ? `${rule.host} 及其子域` : rule.host
  if (rule.pathPrefixes.length === 0) return `允许 https://${scope} 的全部路径`
  return `允许 https://${scope} 的路径前缀 ${rule.pathPrefixes.join('、')}`
}

/** 把用户粘贴的域名或完整网址草稿成一条规则。路径不是 / 时自动成为路径前缀。 */
export function draftSiteRuleFromText(
  raw: string,
  extraPrefixes: string[] = [],
  label?: string
): SiteRulePreview {
  const text = raw.trim()
  const asUrl = text.includes('://') ? normalizeLearningUrl(text) : null
  if (asUrl && !asUrl.ok) return { ok: false, summary: asUrl.reason, error: asUrl.reason }
  const prefixes = [...extraPrefixes]
  if (asUrl?.ok) {
    const path = asUrl.url.pathname || '/'
    if (path !== '/') prefixes.unshift(path)
    return buildSiteRule({ host: asUrl.url.hostname, pathPrefixes: prefixes, label })
  }
  return buildSiteRule({ host: text, pathPrefixes: prefixes, label })
}

export function buildSiteRule(input: {
  host: string
  pathPrefixes?: string[]
  includeSubdomains?: boolean
  label?: string
  enabled?: boolean
  id?: string
}): SiteRulePreview {
  const parsed = parseHostInput(input.host)
  if ('error' in parsed) return { ok: false, summary: parsed.error, error: parsed.error }
  const prefixes: string[] = []
  for (const item of input.pathPrefixes ?? []) {
    const cleaned = cleanPathPrefix(item)
    if (item.trim() && !cleaned) {
      return { ok: false, summary: `路径前缀无效：${item}`, error: `路径前缀无效：${item}` }
    }
    if (cleaned && !prefixes.includes(cleaned)) prefixes.push(cleaned)
  }
  const includeSubdomains = input.includeSubdomains ?? parsed.includeSubdomains
  const rule: LearningSiteRule = {
    id:
      input.id ||
      `site-${stableHash(`${parsed.host}|${includeSubdomains}|${prefixes.join(',')}`)}`,
    host: parsed.host,
    includeSubdomains,
    pathPrefixes: prefixes,
    enabled: input.enabled !== false,
    label: (input.label ?? '').trim() || parsed.host
  }
  return { ok: true, summary: describeSiteRule(rule), rule }
}

export function sameSiteRule(a: LearningSiteRule, b: LearningSiteRule): boolean {
  return (
    a.host === b.host &&
    a.includeSubdomains === b.includeSubdomains &&
    a.pathPrefixes.join('\n') === b.pathPrefixes.join('\n')
  )
}

export function normalizeSiteRules(value: unknown): LearningSiteRule[] {
  if (!Array.isArray(value)) throw new Error('必须是规则列表')
  if (value.length > 50) throw new Error('最多 50 条')
  const rules: LearningSiteRule[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Error('规则格式不正确')
    const row = item as Partial<LearningSiteRule>
    if (typeof row.host !== 'string') throw new Error('域名必须是字符串')
    const preview = buildSiteRule({
      host: row.host,
      pathPrefixes: Array.isArray(row.pathPrefixes) ? row.pathPrefixes.filter((p) => typeof p === 'string') : [],
      includeSubdomains: row.includeSubdomains !== false,
      label: typeof row.label === 'string' ? row.label : '',
      enabled: row.enabled !== false,
      id: typeof row.id === 'string' ? row.id.slice(0, 80) : undefined
    })
    if (!preview.ok || !preview.rule) throw new Error(preview.error ?? '规则无效')
    if (rules.some((existing) => sameSiteRule(existing, preview.rule!))) {
      throw new Error(`重复规则：${preview.rule.host}`)
    }
    rules.push(preview.rule)
  }
  return rules
}

/** 重定向链上第一跳不合法的 URL。全部放行时返回 null。 */
export function firstBlockedHop(chain: string[], rules: LearningSiteRule[]): string | null {
  for (const raw of chain) {
    const normalized = normalizeLearningUrl(raw)
    if (!normalized.ok || !matchSiteRule(normalized.url, rules)) return raw
  }
  return null
}

export function isVideoStudyMode(mode: string): boolean {
  return mode === 'bili' || mode === 'study'
}
