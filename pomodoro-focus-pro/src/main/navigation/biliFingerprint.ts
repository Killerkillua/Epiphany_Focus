import { net, session } from 'electron'
import { logger } from '../logger'

/**
 * B站设备指纹（buvid3 / buvid4）管理模块。
 *
 * 背景：
 * B站对 Web 端搜索接口 `/x/web-interface/wbi/search/type` 实施严格的风控鉴权。
 * 如果客户端请求未携带设备唯一标识指纹（buvid3 / buvid4），
 * 服务端在很多情况下会触发静默防御（返回 code: 0 但空数组或仅推荐词），
 * 或者直接返回 -352 / -412 风控拦截。
 *
 * 本模块负责：
 * 1. 启动或首次搜索前从官方接口 `/x/frontend/finger/spi` 获取合法设备指纹；
 * 2. 内存缓存（TTL 24小时）；
 * 3. 自动同步注入到 Electron defaultSession 的 Cookie 容器中；
 * 4. 为 HTTP 请求头生成标准的 `Cookie` 字符串。
 */

const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi'
const FINGERPRINT_TTL_MS = 24 * 60 * 60 * 1000 // 24小时刷新一次

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/'
}

export interface BiliFingerprint {
  buvid3: string
  buvid4: string
  fetchedAt: number
}

let cachedFingerprint: BiliFingerprint | null = null
let pendingPromise: Promise<BiliFingerprint> | null = null

/** 生成备用 buvid（UUID + infoc 后缀） */
function generateFallbackBuvid3(): string {
  const chars = '0123456789ABCDEF'
  const randomHex = (len: number): string =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}infoc`
}

/** 同步到 Electron Cookie 存储 */
async function syncCookiesToSession(buvid3: string, buvid4: string): Promise<void> {
  try {
    if (session && session.defaultSession && session.defaultSession.cookies) {
      const expirationDate = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
      await session.defaultSession.cookies.set({
        url: 'https://www.bilibili.com',
        domain: '.bilibili.com',
        name: 'buvid3',
        value: buvid3,
        path: '/',
        expirationDate
      })
      if (buvid4) {
        await session.defaultSession.cookies.set({
          url: 'https://www.bilibili.com',
          domain: '.bilibili.com',
          name: 'buvid4',
          value: buvid4,
          path: '/',
          expirationDate
        })
      }
      logger.debug('biliFingerprint', '已将 buvid3/buvid4 写入 defaultSession Cookies')
    }
  } catch (err) {
    logger.warn('biliFingerprint', '写入 session cookies 异常（非致命）', err)
  }
}

async function fetchFingerprint(): Promise<BiliFingerprint> {
  try {
    const res = await net.fetch(SPI_URL, {
      headers: COMMON_HEADERS,
      signal: AbortSignal.timeout(6000)
    })
    if (!res.ok) {
      throw new Error(`SPI 接口响应异常: HTTP ${res.status}`)
    }
    const json = (await res.json()) as {
      code?: number
      data?: { b_3?: string; b_4?: string }
      message?: string
    }
    if (json.code === 0 && json.data?.b_3) {
      const buvid3 = json.data.b_3
      const buvid4 = json.data.b_4 ?? ''
      logger.info('biliFingerprint', `成功获取设备指纹: buvid3=${buvid3.slice(0, 10)}...`)
      await syncCookiesToSession(buvid3, buvid4)
      return { buvid3, buvid4, fetchedAt: Date.now() }
    }
    throw new Error(`SPI 返回非零: code=${json.code} message=${json.message ?? ''}`)
  } catch (err) {
    logger.warn('biliFingerprint', '拉取官方设备指纹失败，回退本地生成指纹', err)
    const fallbackBuvid3 = generateFallbackBuvid3()
    await syncCookiesToSession(fallbackBuvid3, '')
    return { buvid3: fallbackBuvid3, buvid4: '', fetchedAt: Date.now() }
  }
}

/** 获取当前有效的设备指纹 */
export async function getBiliFingerprint(force = false): Promise<BiliFingerprint> {
  if (!force && cachedFingerprint && Date.now() - cachedFingerprint.fetchedAt < FINGERPRINT_TTL_MS) {
    return cachedFingerprint
  }
  if (!pendingPromise) {
    pendingPromise = fetchFingerprint()
      .then((fp) => {
        cachedFingerprint = fp
        return fp
      })
      .finally(() => {
        pendingPromise = null
      })
  }
  return pendingPromise
}

/** 格式化为 HTTP 请求头的 Cookie 字符串 */
export async function getBiliCookieHeader(): Promise<string> {
  const fp = await getBiliFingerprint()
  const parts = [`buvid3=${fp.buvid3}`]
  if (fp.buvid4) {
    parts.push(`buvid4=${fp.buvid4}`)
  }
  return parts.join('; ')
}

/** 启动预热指纹 */
export function warmupFingerprint(): void {
  getBiliFingerprint().catch((err) => {
    logger.warn('biliFingerprint', '指纹预热失败，将在首次搜索时重试', err)
  })
}
