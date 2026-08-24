import { net } from 'electron'
import { signParams, resetWbiCache } from './wbi'
import { getProxiedPicUrl } from '../../shared/bili'
import type { BiliSearchOptions, BiliSearchResponse, BiliVideoItem } from '../../shared/bili'

/**
 * B 站 WBI 签名搜索（核心版）。
 * 端点：GET /x/web-interface/wbi/search/type
 * 支持 search_type=video、order（totalrank/click/pubdate）、分页。
 *
 * 风控自适应（C-3）：
 * - 命中 -412（JSON code 或 HTTP 状态码）时按指数退避等待（1s→2s→4s→8s）并重置 WBI 密钥缓存重试一次，
 *   避免连续请求加剧封禁；连续失败仍抛可读错误提示稍后再试。
 */

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type'

/** 单次搜索请求超时（ms）：网络异常或服务端不响应时终止挂起，避免 IPC 处理器无限等待 */
const SEARCH_TIMEOUT_MS = 10_000

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/'
}

/** -412 风控专用错误（内部哨兵，避免把退避逻辑耦合进网络错误分支） */
class RiskBlockedError extends Error {
  constructor() {
    super('B 站风控拦截（-412）')
    this.name = 'RiskBlockedError'
  }
}

/** 风控退避状态：连续命中 -412 的次数（决定下一次等待时长） */
let consecutiveRisk = 0
const RISK_BASE_DELAY_MS = 1000
const RISK_MAX_DELAY_MS = 8000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface RawSearchItem {
  type?: string
  bvid?: string
  title?: string
  pic?: string
  play?: number | string
  danmaku?: number | string
  duration?: string
  author?: string
  mid?: number | string
  pubdate?: number | string
  description?: string
}

interface RawSearchResponse {
  code?: number
  message?: string
  data?: {
    result?: RawSearchItem[]
    numResults?: number
    numPages?: number
    page?: number
  }
}

/** 去除 B 站搜索接口返回的 <em class="keyword"> 高亮标签 */
function cleanTitle(title: string): string {
  return title.replace(/<em[^>]*>([\s\S]*?)<\/em>/g, '$1')
}

/** 归一化封面 URL（// 开头的协议相对地址补 https:） */
function normalizePic(pic: string): string {
  return pic.startsWith('//') ? `https:${pic}` : pic
}

function mapItem(raw: RawSearchItem): BiliVideoItem {
  const pic = normalizePic(raw.pic ?? '')
  return {
    bvid: String(raw.bvid ?? ''),
    title: cleanTitle(raw.title ?? ''),
    pic,
    picProxied: getProxiedPicUrl(pic),
    play: Number(raw.play ?? 0),
    danmaku: Number(raw.danmaku ?? 0),
    duration: String(raw.duration ?? ''),
    author: String(raw.author ?? ''),
    mid: Number(raw.mid ?? 0),
    pubdate: Number(raw.pubdate ?? 0),
    description: String(raw.description ?? '')
  }
}

/**
 * 搜索视频。
 * @throws 关键词为空 / 网络异常 / B 站返回 code!=0 时抛出可读错误
 */
export async function searchBiliVideo(options: BiliSearchOptions): Promise<BiliSearchResponse> {
  const keyword = (options.keyword ?? '').trim()
  if (!keyword) {
    throw new Error('搜索关键词不能为空')
  }

  const params: Record<string, string | number> = {
    search_type: 'video',
    keyword,
    page: options.page ?? 1
  }
  if (options.order) params['order'] = options.order
  if (options.duration) params['duration'] = options.duration

  /** 单次请求（网络异常 / -412 风控均抛出可读错误） */
  async function attempt(): Promise<BiliSearchResponse> {
    const signed = await signParams(params)
    const query = new URLSearchParams(signed).toString()

    let res: Response
    try {
      res = await net.fetch(`${SEARCH_URL}?${query}`, {
        headers: COMMON_HEADERS,
        // 超时中止：AbortSignal.timeout 触发时 net.fetch reject（TimeoutError/AbortError）
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 区分超时与一般网络错误，给出可读提示
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`搜索请求超时（${SEARCH_TIMEOUT_MS / 1000}s），请稍后再试`)
      }
      throw new Error(`搜索请求失败: ${msg}`)
    }
    // HTTP 层 -412 同样是风控拦截（与 JSON code=-412 同语义），走退避重试
    if (res.status === 412) {
      throw new RiskBlockedError()
    }
    if (!res.ok) {
      throw new Error(`搜索请求失败（HTTP ${res.status}）`)
    }

    const json = (await res.json()) as RawSearchResponse
    if (json.code !== 0) {
      // -412 为风控拦截，走退避重试
      if (json.code === -412) {
        throw new RiskBlockedError()
      }
      throw new Error(`B 站搜索返回错误: code=${json.code} message=${json.message ?? ''}`)
    }

    const data = json.data
    const rawList = Array.isArray(data?.result) ? data.result : []
    const items = rawList.filter((item) => item?.type === 'video').map(mapItem)

    return {
      items,
      numResults: Number(data?.numResults ?? items.length),
      numPages: Number(data?.numPages ?? 1),
      page: Number(data?.page ?? options.page ?? 1)
    }
  }

  try {
    const result = await attempt()
    consecutiveRisk = 0
    return result
  } catch (err) {
    if (!(err instanceof RiskBlockedError)) throw err
    // C-3 风控自适应：指数退避等待 + 重置 WBI 密钥缓存后重试一次
    consecutiveRisk += 1
    const delay = Math.min(RISK_MAX_DELAY_MS, RISK_BASE_DELAY_MS * 2 ** (consecutiveRisk - 1))
    await sleep(delay)
    resetWbiCache()
    try {
      const retry = await attempt()
      consecutiveRisk = 0
      return retry
    } catch (retryErr) {
      if (retryErr instanceof RiskBlockedError) {
        throw new Error(
          `搜索被风控拦截（-412），已自动退避 ${Math.round(delay / 1000)}s 并刷新密钥仍失败。` +
            '请稍后再试或更换网络环境；频繁触发请降低搜索频率。'
        )
      }
      throw retryErr
    }
  }
}
