import { app, net, protocol, session } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { BILI_IMAGE_SCHEME } from '../../shared/bili'

/**
 * B 站封面图代理（修复防盗链 403，方案 A1/A1'/A2）：
 * - bili-image:// 自定义协议：主进程 net.fetch + Referer 拉图，失败降级为 SVG 占位
 * - webRequest.onBeforeSendHeaders：渲染层 <img> 直连 hdslb/bilibili 图片时注入 Referer（双保险）
 * - 磁盘缓存：userData/image-cache，LRU 上限 500 张 / 200MB，二次搜索不重复拉图
 */

const REFERER = 'https://www.bilibili.com/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 磁盘缓存限制（LRU） */
const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 200 * 1024 * 1024

interface CacheMeta {
  key: string
  mime: string
  size: number
  mtime: number
}

let cacheDir = ''
let cacheIndex: CacheMeta[] = []
let cacheReady = false

function cacheKey(rawUrl: string): string {
  return createHash('sha1').update(rawUrl).digest('hex')
}

function guessMime(url: string): string {
  const lower = url.toLowerCase()
  if (lower.includes('.png')) return 'image/png'
  if (lower.includes('.webp')) return 'image/webp'
  if (lower.includes('.gif')) return 'image/gif'
  return 'image/jpeg'
}

/* ===== 磁盘缓存（LRU） ===== */

async function ensureCacheDir(): Promise<void> {
  if (cacheDir) await fs.mkdir(cacheDir, { recursive: true })
}

async function loadCacheIndex(): Promise<void> {
  try {
    const raw = await fs.readFile(join(cacheDir, 'index.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { entries?: CacheMeta[] }
    cacheIndex = Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    cacheIndex = []
  }
  cacheReady = true
}

async function saveCacheIndex(): Promise<void> {
  try {
    await fs.writeFile(
      join(cacheDir, 'index.json'),
      JSON.stringify({ entries: cacheIndex }),
      'utf-8'
    )
  } catch {
    /* 索引写失败不影响展示 */
  }
}

async function cacheGet(rawUrl: string): Promise<{ data: Buffer; mime: string } | null> {
  if (!cacheReady) return null
  const key = cacheKey(rawUrl)
  const meta = cacheIndex.find((entry) => entry.key === key)
  if (!meta) return null
  try {
    const data = await fs.readFile(join(cacheDir, `${key}.img`))
    // LRU 命中：更新 mtime 并置顶
    meta.mtime = Date.now()
    cacheIndex = [...cacheIndex.filter((entry) => entry.key !== key), meta]
    void saveCacheIndex()
    return { data, mime: meta.mime }
  } catch {
    return null
  }
}

async function cachePut(rawUrl: string, data: Buffer, mime: string): Promise<void> {
  if (!cacheReady) return
  const key = cacheKey(rawUrl)
  cacheIndex = cacheIndex.filter((entry) => entry.key !== key)
  cacheIndex.push({ key, mime, size: data.byteLength, mtime: Date.now() })
  await Promise.all([
    fs.writeFile(join(cacheDir, `${key}.img`), data).catch(() => undefined),
    pruneCache()
  ])
  void saveCacheIndex()
}

async function pruneCache(): Promise<void> {
  let total = cacheIndex.reduce((sum, entry) => sum + entry.size, 0)
  while (cacheIndex.length > CACHE_MAX_ENTRIES || total > CACHE_MAX_BYTES) {
    const oldest = cacheIndex.shift()
    if (!oldest) break
    total -= oldest.size
    await fs.unlink(join(cacheDir, `${oldest.key}.img`)).catch(() => undefined)
  }
}

/* ===== 降级占位 ===== */

function fallbackSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250" viewBox="0 0 400 250">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    '<stop offset="0" stop-color="#1c222b"/><stop offset="1" stop-color="#0d1016"/>',
    '</linearGradient></defs>',
    '<rect width="400" height="250" fill="url(#g)"/>',
    '<circle cx="200" cy="118" r="34" fill="none" stroke="rgba(255,255,255,0.32)" stroke-width="3"/>',
    '<path d="M192 100 L222 118 L192 136 Z" fill="rgba(255,255,255,0.32)"/>',
    '</svg>'
  ].join('')
}

function fallbackResponse(): Response {
  return new Response(fallbackSvg(), {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml' }
  })
}

/* ===== 协议安装（app ready 后调用） ===== */

export function installBiliImageProxy(): void {
  cacheDir = join(app.getPath('userData'), 'image-cache')
  void ensureCacheDir().then(loadCacheIndex)

  protocol.handle(BILI_IMAGE_SCHEME, async (request) => {
    try {
      const parsed = new URL(request.url)
      const raw = parsed.searchParams.get('url')
      if (!raw || !/^https:\/\//i.test(raw)) return fallbackResponse()

      // 1. 缓存命中直接返回
      const hit = await cacheGet(raw)
      if (hit) {
        return new Response(hit.data, {
          headers: { 'Content-Type': hit.mime, 'Cache-Control': 'public, max-age=86400' }
        })
      }

      // 2. 主进程带 Referer 拉图（绕过 CDN 防盗链 403）
      const res = await net.fetch(raw, {
        headers: { Referer: REFERER, 'User-Agent': USER_AGENT },
        redirect: 'follow'
      })
      if (!res.ok) return fallbackResponse()

      const data = Buffer.from(await res.arrayBuffer())
      const mime = res.headers.get('content-type')?.split(';')[0] ?? guessMime(raw)
      void cachePut(raw, data, mime).catch(() => undefined)
      return new Response(data, {
        headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
      })
    } catch {
      return fallbackResponse()
    }
  })

  // 兜底：渲染层 <img> 直连 CDN / 视频窗口内部图片请求也统一注入 Referer
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const host = new URL(details.url).hostname
      const isBiliImage =
        details.resourceType === 'image' &&
        (host === 'hdslb.com' ||
          host.endsWith('.hdslb.com') ||
          host === 'bilibili.com' ||
          host.endsWith('.bilibili.com'))
      if (isBiliImage) details.requestHeaders['Referer'] = REFERER
    } catch {
      /* 解析失败忽略 */
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}
