/**
 * 视频学习模式共享类型（主进程 / preload / 渲染层共用）。
 * 仅类型定义，不引入任何运行时依赖。
 */

import type { BiliStrictness } from './settings'
import type { SessionSource } from './stats'

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
  /** 原始 CDN 封面 URL（调试 / 复制原始链接用） */
  pic: string
  /** bili-image:// 代理封面 URL（主进程注入 Referer 拉图，防防盗链 403） */
  picProxied: string
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

/** 视频学习导航守卫上下文（跨模块传递） */
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
  /** 视频标题（搜索结果页快照，注入 AI 上下文 / 笔记归档） */
  title?: string
  /** 会话上限时长（毫秒，来自首页时长浮层） */
  plannedMs?: number
  /** 打开后跳转到指定进度（秒，续学入口；视频学习原生 ?t= 参数，加载即定位） */
  seekSeconds?: number
  /** 打开来源：manual / resume（续学）/ search（搜索结果）；写入 study_sessions.source（M3） */
  source?: SessionSource
  /** 封面图 URL（bili-image:// 代理地址，搜索结果页快照；写入 play_records.cover_url） */
  coverUrl?: string
  /** UP 主名称（搜索结果页快照；写入 play_records.author） */
  author?: string
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
  /** 当前视频标题（搜索结果页快照，导航守卫提取到更精确标题时更新） */
  videoTitle?: string
  fullscreen: boolean
}

/** 悬浮面板窗口尺寸（px） */
export interface OverlaySize {
  width: number
  height: number
}

/**
 * 悬浮面板展开尺寸（px，主进程 biliWindow 与渲染层 OverlayApp 共用）。
 * 学习助手重构后始终以展开态呈现，最小窗口 610×940（可拖拽 header 移动、可系统级缩放）。
 */
export const OVERLAY_EXPANDED_SIZE: OverlaySize = { width: 610, height: 940 }

/**
 * 悬浮面板完整状态机（3 态，已删除 collapsed 悬浮球态）：
 * - expanded ：610×940 展开面板（AI 助手 + 记事本 + 进度），可拖拽 header 移动、可缩放（最小 610×940）
 * - minimized：窗口最小化（仅 L0/L1 档允许；L2 档自动降级为 hidden）
 * - hidden   ：完全隐藏，Ctrl+Shift+O 呼出或 BiliModePage 按钮切换
 */
export type OverlayState = 'expanded' | 'minimized' | 'hidden'

/** 悬浮面板状态定义（尺寸 + 是否可见） */
export interface OverlayStateDef {
  size: OverlaySize
  visible: boolean
}

export const OVERLAY_STATES: Record<OverlayState, OverlayStateDef> = {
  expanded: { size: OVERLAY_EXPANDED_SIZE, visible: true },
  minimized: { size: { width: 0, height: 0 }, visible: false },
  hidden: { size: { width: 0, height: 0 }, visible: false }
}

/** 悬浮面板完整状态快照（主进程 → 渲染层同步） */
export interface OverlaySnapshot {
  state: OverlayState
  size: OverlaySize
  /** 当前锁定档是否允许最小化（L2 不允许，minimized 会降级为 hidden） */
  canMinimize: boolean
  /** 状态切换时的用户提示（如 L2 不允许最小化时的降级说明） */
  notice?: string
}

/* ===== 视频学习封面图代理（防盗链修复） ===== */

/** 封面代理自定义协议（主进程 protocol.handle，渲染层 <img> 直接使用） */
export const BILI_IMAGE_SCHEME = 'bili-image'

/**
 * 把 CDN 封面原始 URL 转成 bili-image:// 代理地址。
 * 主进程按此协议用 net.fetch + Referer 拉图（解决 视频学习 CDN 防盗链 403）。
 */
export function getProxiedPicUrl(rawPic: string): string {
  const url = rawPic.startsWith('//') ? `https:${rawPic}` : rawPic
  if (!url) return ''
  return `${BILI_IMAGE_SCHEME}://img/?url=${encodeURIComponent(url)}`
}

/* ===== AI 学习助手（视频学习悬浮面板） ===== */

export interface AiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AiAskRequest {
  /** 渲染层生成的请求关联 ID：流式 ai:chunk 事件用同一 id 关联到消息（缺省主进程生成） */
  requestId?: string
  message: string
  context?: {
    /** 学习主题（来自搜索关键词） */
    topic?: string
    videoTitle?: string
    /** 当前视频 BV 号 */
    bvid?: string
  }
  /** 最近多轮历史（按时间升序，仅 user/assistant 参与组装） */
  history?: AiMessage[]
}

/** 视频学习助手完整回复（与英语模式 shared/ai.ts 的 AiReply 命名区分，避免同名异构冲突） */
export interface BiliAiReply {
  role: 'assistant'
  content: string
  /** 引用来源（RAG 接入后填充） */
  sources?: string[]
}

/* ===== 记事本 ===== */

/** 笔记来源：主窗口记事本 / 悬浮面板 / AI 一键入笔记 / 时间点标记 */
export type NoteSource = 'main' | 'overlay' | 'ai' | 'time-mark'

export interface NoteEntry {
  id: string
  createdAt: number
  content: string
  /** 关联视频 BV 号（按视频归档 / 回看定位） */
  bvid?: string
  /** 视频标题快照（笔记页展示所属视频） */
  videoTitle?: string
  /** 视频内进度秒（时间点标记，点击可跳转播放器到该位置） */
  timestampS?: number
  /** 重点标记（★ 只看重点过滤） */
  isKey?: boolean
  /** 来源（用于过滤 AI 沉淀 / 时间点标记） */
  source?: NoteSource
}

/** 时间点标记跳转（F-2）：让视频窗口 seek 到指定进度 */
export interface SeekToPayload {
  bvid: string
  /** 目标进度（秒） */
  seconds: number
}
