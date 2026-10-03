import { net } from 'electron'
import { createHash } from 'node:crypto'

/**
 * 视频学习 WBI 签名（核心版）。
 *
 * 流程：启动/失效时调 GET /x/web-interface/nav 取当日 img-key / sub-key，
 * 按 MIXIN_KEY_ENC_TAB 重排映射表生成 mixin-key（取拼接串前 32 位），
 * 请求参数按 key 升序 + wts 时间戳，过滤 value 中的 !'()* 字符，
 * 拼 query + mixin-key 后 MD5 得 w-rid。
 *
 * 密钥缓存 4 小时自动刷新，避免频繁调 nav 触发风控；
 * 并发请求共享同一 pending Promise，防止重复拉取。
 */

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

/** 密钥缓存有效期：4 小时 */
export const WBI_KEY_TTL_MS = 4 * 60 * 60 * 1000

/**
 * 视频学习前端内置的全局默认密钥对（公开、长期稳定、与登录状态无关）。
 * 当 nav 未返回 wbi_img（如未登录 code=-101 且无密钥字段）时回退使用。
 */
const FALLBACK_WBI_KEYS: WbiKeys = {
  imgKey: '7cd084941338484aae1ad9425b84077c',
  subKey: '4932caff0ff746eab6f01bf08b70ac45'
}

/** bilibili-API-collect 标准重排映射表 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/'
}

export interface WbiKeys {
  imgKey: string
  subKey: string
}

interface WbiKeyCache extends WbiKeys {
  fetchedAt: number
}

let cache: WbiKeyCache | null = null
let pending: Promise<WbiKeyCache> | null = null

/** 从图片 URL 提取密钥文件名主干（去目录与扩展名） */
function extractKey(url: string): string {
  const name = url.split('/').pop() ?? ''
  return name.split('.')[0]
}

/** 拼接 img-key + sub-key，按映射表取前 32 位生成 mixin-key */
function buildMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  let key = ''
  for (let i = 0; i < 32; i++) {
    key += raw[MIXIN_KEY_ENC_TAB[i]]
  }
  return key
}

async function fetchKeysFromNav(): Promise<WbiKeyCache> {
  let res: Response
  try {
    res = await net.fetch(NAV_URL, { headers: COMMON_HEADERS })
  } catch (err) {
    throw new Error(
      `WBI 密钥获取失败（nav 请求异常）: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!res.ok) {
    throw new Error(`WBI 密钥获取失败（nav HTTP ${res.status}）`)
  }
  const json = (await res.json()) as {
    code?: number
    message?: string
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }
  const imgUrl = json.data?.wbi_img?.img_url
  const subUrl = json.data?.wbi_img?.sub_url
  // 注意：未登录（code=-101）时 nav 仍会返回 wbi_img 全局密钥，因此不能因 code!==0 直接抛错，
  // 只要拿到了密钥即可用于签名；仅当 nav 未返回 wbi_img 时才回退内置默认密钥对。
  if (imgUrl && subUrl) {
    return { imgKey: extractKey(imgUrl), subKey: extractKey(subUrl), fetchedAt: Date.now() }
  }
  console.warn(
    `[wbi] nav 未返回 wbi_img（code=${json.code ?? ''} message=${json.message ?? ''}），回退内置默认密钥对`
  )
  return { ...FALLBACK_WBI_KEYS, fetchedAt: Date.now() }
}

/**
 * 获取 WBI 密钥（带 4h 缓存 + 并发去重）。
 * @param force 强制刷新（忽略缓存）
 */
export async function getWbiKeys(force = false): Promise<WbiKeys> {
  if (!force && cache && Date.now() - cache.fetchedAt < WBI_KEY_TTL_MS) {
    return cache
  }
  if (!pending) {
    pending = fetchKeysFromNav()
      .then((keys) => {
        cache = keys
        return keys
      })
      .finally(() => {
        pending = null
      })
  }
  return pending
}

/** 应用启动时预热缓存（失败静默，待首次搜索时再拉取） */
export function warmupWbiCache(): void {
  getWbiKeys().catch((err) => {
    console.warn('[wbi] 预热密钥失败，首次搜索时将重试:', err instanceof Error ? err.message : err)
  })
}

/**
 * 对请求参数签名：追加 wts / w_rid。
 * @returns 可直接拼入 query 的完整参数（含 wts 与 w_rid）
 */
export async function signParams(
  params: Record<string, string | number>
): Promise<Record<string, string>> {
  const { imgKey, subKey } = await getWbiKeys()
  const mixinKey = buildMixinKey(imgKey, subKey)
  const wts = Math.floor(Date.now() / 1000)

  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    merged[key] = String(value)
  }
  merged['wts'] = String(wts)

  // 按 key 升序；value 过滤 !'()* 字符后 URL 编码
  const query = Object.keys(merged)
    .sort()
    .filter((key) => key !== 'w_rid')
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(merged[key].replace(/[!'()*]/g, ''))}`
    )
    .join('&')

  merged['w_rid'] = createHash('md5')
    .update(query + mixinKey)
    .digest('hex')
  return merged
}

/** 清除密钥缓存（强制下一次重新拉取，调试用） */
export function resetWbiCache(): void {
  cache = null
}
