import { net } from 'electron'
import { signParams } from './wbi'
import { getProxiedPicUrl } from '../../shared/bili'
import type { BiliSearchOptions, BiliSearchResponse, BiliVideoItem } from '../../shared/bili'

/**
 * B 站 WBI 签名搜索（核心版）。
 * 端点：GET /x/web-interface/wbi/search/type
 * 支持 search_type=video、order（totalrank/click/pubdate）、分页。
 */

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type'

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/'
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

  const signed = await signParams(params)
  const query = new URLSearchParams(signed).toString()

  let res: Response
  try {
    res = await net.fetch(`${SEARCH_URL}?${query}`, { headers: COMMON_HEADERS })
  } catch (err) {
    throw new Error(`搜索请求失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`搜索请求失败（HTTP ${res.status}）`)
  }

  const json = (await res.json()) as RawSearchResponse
  if (json.code !== 0) {
    // -412 为风控拦截，提示稍后重试
    if (json.code === -412) {
      throw new Error('搜索被风控拦截（-412），请稍后重试或刷新 WBI 密钥')
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
