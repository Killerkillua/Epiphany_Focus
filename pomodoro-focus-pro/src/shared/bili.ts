/**
 * B 站模式共享类型（主进程 / preload / 渲染层共用）。
 * 仅类型定义，不引入任何运行时依赖。
 */

import type { BiliStrictness } from './settings'

/** 搜索结果排序方式 */
export type BiliOrder = 'totalrank' | 'click' | 'pubdate'

export interface BiliSearchOptions {
  keyword: string
  /** 页码，从 1 开始 */
  page?: number
  order?: BiliOrder
  /** 视频时长过滤（分钟），核心版暂不使用 */
  duration?: number
}

/** 单条视频搜索结果（已清洗 title 高亮标签） */
export interface BiliVideoItem {
  bvid: string
  title: string
  pic: string
  play: number
  danmaku: number
  duration: string
  author: string
  mid: number
  pubdate: number
  description: string
}

export interface BiliSearchResponse {
  items: BiliVideoItem[]
  numResults: number
  numPages: number
  page: number
}

/** 导航拦截的类别 */
export type NavCategory = '直播' | '番剧' | '影视' | '动态' | '外部' | '无关内容' | '历史回退'

/** 四层判定层级 */
export type NavVerdictLevel = 'L1' | 'L2' | 'L3' | 'L4'

/** B 站导航守卫上下文（跨模块传递） */
export interface BiliGuardContext {
  /** 学习主题（来自搜索关键词） */
  topic: string
  /** 相关度档位：strict / standard / loose */
  strictness: BiliStrictness
  /** 严格档可放行的 BV 集合（当前搜索结果列表） */
  allowedBvs: string[]
}

/** L1–L4 四层判定的结果 */
export interface NavVerdict {
  allowed: boolean
  /** 判定层级：L1 域名 / L2 路径 / L3 历史 / L4 内容；放行时为 null */
  level: NavVerdictLevel | null
  category: NavCategory | null
  reason: string
  url: string
  host: string
  path: string
}

export interface OpenVideoPayload {
  bvid: string
  /** 是否自动全屏（可配开关） */
  autoFullscreen: boolean
  /** 学习主题（搜索关键词），供 AI / 记事本上下文使用 */
  topic?: string
  /** 会话上限时长（毫秒，来自首页时长浮层） */
  plannedMs?: number
}

/** 标记某 BV 为"与主题相关" */
export interface MarkRelevantPayload {
  bvid: string
}

export interface VideoState {
  open: boolean
  bvid?: string
  fullscreen: boolean
  autoFullscreen: boolean
}

export interface BiliContext {
  bvid?: string
  topic?: string
  fullscreen: boolean
}

/** 悬浮面板窗口尺寸（px） */
export interface OverlaySize {
  width: number
  height: number
}

/** 悬浮面板展开 / 折叠尺寸（主进程 biliWindow 与渲染层 OverlayApp 共用） */
export const OVERLAY_EXPANDED_SIZE: OverlaySize = { width: 340, height: 560 }
export const OVERLAY_COLLAPSED_SIZE: OverlaySize = { width: 64, height: 240 }

/* ===== AI 网关占位接口 ===== */

export interface AiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AiAskRequest {
  message: string
  context?: {
    topic?: string
    videoTitle?: string
  }
}

export interface AiReply {
  role: 'assistant'
  content: string
  /** 引用来源（RAG 接入后填充） */
  sources?: string[]
}

/* ===== 记事本 ===== */

export interface NoteEntry {
  id: string
  createdAt: number
  content: string
}
