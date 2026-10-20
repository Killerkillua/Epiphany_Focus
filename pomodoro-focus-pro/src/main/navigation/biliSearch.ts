import { net } from 'electron'
import { signParams, resetWbiCache } from './wbi'
import { getProxiedPicUrl } from '../../shared/bili'
import type { BiliSearchOptions, BiliSearchResponse, BiliVideoItem } from '../../shared/bili'
import { logger } from '../logger'
import { getBiliCookieHeader } from './biliFingerprint'

/**
 * 视频学习搜索核心服务（高可用双通道流水线）。
 *
 * 架构设计：
 * 1. 主通道（WBI 签名搜索）：
 *    端点：GET /x/web-interface/wbi/search/type
 *    携带每日动态 mixin_key 签名与 buvid3/buvid4 设备指纹。
 * 2. 免验高容灾兜底通道（Web 全站搜索）：
 *    端点：GET /x/web-interface/search/all/v2
 *    当主通道触发 B 站风控质询（v_voucher）、错误码（-412 / -352）、静默空结果或网络异常时，
 *    自动无缝切入兜底通道，提取 video 分类数据并归一化输出。
 *    用户端零报错、无感穿透风控，彻底根除“人机验证质询”与“零结果”问题。
 */

const WBI_SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
const FALLBACK_SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/all/v2'

/** 单次搜索请求超时（ms）：网络异常或服务端不响应时终止挂起，避免 IPC 处理器无限等待 */
const SEARCH_TIMEOUT_MS = 10_000

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
}

/** -412 / -352 风控专用错误（内部哨兵，避免把退避逻辑耦合进网络错误分支） */
class RiskBlockedError extends Error {
  constructor(message = '视频学习风控拦截（-412）') {
    super(message)
    this.name = 'RiskBlockedError'
  }
}

/** 风控退避状态：连续命中风控的次数（决定下一次等待时长） */
let consecutiveRisk = 0
const RISK_BASE_DELAY_MS = 1000
const RISK_MAX_DELAY_MS = 8000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface RawSearchItem {
  type?: string
  bvid?: string
  aid?: number | string
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

interface RawWbiResponse {
  code?: number
  message?: string
  data?: {
    seid?: string
    v_voucher?: string
    result?: RawSearchItem[]
    numResults?: number
    numPages?: number
    page?: number
  }
}

interface RawFallbackCategoryItem {
  result_type?: string
  type?: string
  data?: RawSearchItem[]
}

interface RawFallbackResponse {
  code?: number
  message?: string
  data?: {
    seid?: string
    numResults?: number
    numPages?: number
    page?: number
    result?: RawFallbackCategoryItem[]
  }
}

/** 去除 视频学习搜索接口返回的 <em class="keyword"> 高亮标签 */
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
 * 容灾兜底搜索（免验通道）。
 * 使用 B 站标准的 search/all/v2 接口，无需 WBI 签名，天然免疫 v_voucher 人机验证风控。
 */
async function searchFallback(options: BiliSearchOptions): Promise<BiliSearchResponse> {
  const keyword = (options.keyword ?? '').trim()
  const page = options.page ?? 1

  const url = new URL(FALLBACK_SEARCH_URL)
  url.searchParams.set('keyword', keyword)
  url.searchParams.set('page', String(page))
  if (options.order) url.searchParams.set('order', options.order)
  if (options.duration) url.searchParams.set('duration', String(options.duration))

  const cookieHeader = await getBiliCookieHeader().catch(() => '')
  const headers: Record<string, string> = { ...COMMON_HEADERS }
  if (cookieHeader) headers['Cookie'] = cookieHeader

  logger.info('biliSearch', `尝试执行免验兜底搜索通道: kw="${keyword}" page=${page}`)

  const res = await net.fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  })

  if (!res.ok) {
    throw new Error(`兜底搜索响应异常: HTTP ${res.status}`)
  }

  const json = (await res.json()) as RawFallbackResponse
  if (json.code !== 0) {
    throw new Error(`兜底搜索接口返回错误: code=${json.code} message=${json.message ?? ''}`)
  }

  const data = json.data
  const rawCategories = Array.isArray(data?.result) ? data.result : []
  // 从全站综合搜索结果中找到视频块（result_type 为 'video'）
  const videoCategory = rawCategories.find(
    (cat) => cat && (cat.result_type === 'video' || cat.type === 'video')
  )
  const rawList = Array.isArray(videoCategory?.data) ? videoCategory.data : []
  const items = rawList.filter((item) => item && Boolean(item.bvid)).map(mapItem)

  logger.info(
    'biliSearch',
    `免验兜底搜索成功: kw="${keyword}" page=${page} 提取有效视频=${items.length}条 ` +
      `总结果=${data?.numResults ?? items.length}`
  )

  return {
    items,
    numResults: Number(data?.numResults ?? items.length),
    numPages: Number(data?.numPages ?? 1),
    page: Number(data?.page ?? page)
  }
}

/**
 * 搜索视频（主入口）。
 * 顺序：
 * 1. 优先尝试主通道（WBI 签名搜索）；
 * 2. 若命中 v_voucher 人机验证、-412/-352 风控、空结果或网络异常，立即无缝切入免验兜底通道；
 * 3. 仅当双通道皆尽失败时，才抛出带有明确诊断信息的异常。
 */
export async function searchBiliVideo(options: BiliSearchOptions): Promise<BiliSearchResponse> {
  const keyword = (options.keyword ?? '').trim()
  if (!keyword) {
    throw new Error('搜索关键词不能为空')
  }

  const params: Record<string, string | number> = {
    search_type: 'video',
    keyword,
    page: options.page ?? 1,
    page_size: 20
  }
  if (options.order) params['order'] = options.order
  if (options.duration) params['duration'] = options.duration

  /** 尝试执行 WBI 签名搜索 */
  async function attemptWbi(): Promise<BiliSearchResponse> {
    const startAt = Date.now()
    const signed = await signParams(params)

    // 严格按 RFC3986 规范编码 URL Query
    const query = Object.keys(signed)
      .sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(signed[key])}`)
      .join('&')

    const cookieHeader = await getBiliCookieHeader().catch(() => '')
    const headers: Record<string, string> = { ...COMMON_HEADERS }
    if (cookieHeader) headers['Cookie'] = cookieHeader

    let res: Response
    try {
      res = await net.fetch(`${WBI_SEARCH_URL}?${query}`, {
        headers,
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('biliSearch', `WBI 主通道请求网络异常: ${msg}`)
      throw err
    }

    if (res.status === 412) {
      logger.warn('biliSearch', 'WBI 主通道 HTTP 412 风控拦截')
      throw new RiskBlockedError('WBI 主通道 HTTP 412 风控拦截')
    }
    if (!res.ok) {
      logger.warn('biliSearch', `WBI 主通道响应非 200: HTTP ${res.status}`)
      throw new Error(`WBI 主通道响应 HTTP ${res.status}`)
    }

    const json = (await res.json()) as RawWbiResponse
    const elapsed = Date.now() - startAt

    // 关键优化：若 B 站返回 v_voucher 人机验证质询，不直接抛错中断，而是标记为风控以便切入免验兜底
    if (json.data?.v_voucher) {
      logger.warn(
        'biliSearch',
        `WBI 主通道返回人机验证质询（v_voucher=${json.data.v_voucher}），将自动触发兜底容灾通道`
      )
      throw new RiskBlockedError('触发 B 站人机验证质询（v_voucher）')
    }

    if (json.code !== 0) {
      if (json.code === -412 || json.code === -352) {
        logger.warn('biliSearch', `WBI 主通道业务风控: code=${json.code} message=${json.message ?? ''}`)
        throw new RiskBlockedError(`WBI 主通道风控拦截（${json.code}）`)
      }
      throw new Error(`WBI 主通道返回错误: code=${json.code} message=${json.message ?? ''}`)
    }

    const data = json.data
    const rawList = Array.isArray(data?.result) ? data.result : []
    const items = rawList
      .filter((item) => {
        if (!item) return false
        if (item.type && item.type !== 'video') return false
        return Boolean(item.bvid)
      })
      .map(mapItem)

    logger.info(
      'biliSearch',
      `WBI 主通道完成 [${elapsed}ms]: kw="${keyword}" page=${options.page ?? 1} seid=${data?.seid ?? '-'} ` +
        `有效视频=${items.length} 总数=${data?.numResults ?? 0}`
    )

    // 若 WBI 接口静默下发 0 条数据，判定为主通道降级，抛出异常触发兜底通道
    if (items.length === 0) {
      logger.warn('biliSearch', `WBI 主通道返回 0 条结果，将尝试免验兜底通道`)
      throw new Error('WBI_EMPTY_RESULTS')
    }

    return {
      items,
      numResults: Number(data?.numResults ?? items.length),
      numPages: Number(data?.numPages ?? 1),
      page: Number(data?.page ?? options.page ?? 1)
    }
  }

  // 第一步：尝试 WBI 主通道
  try {
    const result = await attemptWbi()
    consecutiveRisk = 0
    return result
  } catch (wbiErr) {
    const isRisk = wbiErr instanceof RiskBlockedError
    const isWbiEmpty = wbiErr instanceof Error && wbiErr.message === 'WBI_EMPTY_RESULTS'

    logger.warn(
      'biliSearch',
      `WBI 主通道未能满足请求（${wbiErr instanceof Error ? wbiErr.message : String(wbiErr)}），立即切入免验兜底通道`
    )

    // 第二步：无缝执行免验兜底通道
    try {
      const fallbackResult = await searchFallback(options)
      if (fallbackResult.items.length > 0) {
        logger.info(
          'biliSearch',
          `免验兜底通道成功挽救搜索请求，返回 ${fallbackResult.items.length} 条有效结果`
        )
        return fallbackResult
      }
      // 如果兜底通道也返回 0 条（确实不存在该关键词视频）
      return fallbackResult
    } catch (fallbackErr) {
      logger.error('biliSearch', '免验兜底通道亦发生异常', fallbackErr)
    }

    // 第三步：若兜底通道也发生网络故障，且原因为风控，走退避重试主通道一次
    if (isRisk) {
      consecutiveRisk += 1
      const delay = Math.min(RISK_MAX_DELAY_MS, RISK_BASE_DELAY_MS * 2 ** (consecutiveRisk - 1))
      logger.warn('biliSearch', `双通道均受阻，执行退避 ${delay}ms 并刷新密钥重试`)
      await sleep(delay)
      resetWbiCache()
      try {
        const retry = await attemptWbi()
        consecutiveRisk = 0
        return retry
      } catch (retryErr) {
        // 重试失败再次尝试兜底
        return await searchFallback(options)
      }
    }

    if (isWbiEmpty) {
      return { items: [], numResults: 0, numPages: 1, page: options.page ?? 1 }
    }

    throw wbiErr
  }
}
