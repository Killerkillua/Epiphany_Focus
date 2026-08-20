import type { IPC_CHANNELS, IPC_EVENTS } from '../main/ipc'
import type {
  AiAskRequest,
  AiReply,
  BiliContext,
  BiliSearchOptions,
  BiliSearchResponse,
  MarkRelevantPayload,
  NavVerdict,
  NoteEntry,
  OpenVideoPayload,
  OverlaySize,
  OverlaySnapshot,
  OverlayState,
  SeekToPayload,
  VideoState
} from '../shared/bili'
import type {
  AddGrammarPayload,
  AddVocabPayload,
  AiConfig,
  AiQuestion,
  AiReply as EnglishAiReply,
  AiUsage,
  GrammarPoint,
  OcrRequest,
  OcrResult,
  VocabEntry
} from '../shared/ai'
import type { AssetInfo } from '../shared/audio'
import type { AppSettings, EmergencyExitResult } from '../shared/settings'
import type {
  DayTrendPoint,
  FeedbackEntry,
  FeedbackStats,
  HeatmapCell,
  HomeSummary,
  ModeStat,
  PlayRecord,
  PlayRecordTick
} from '../shared/stats'
import type { SessionStartOptions, SessionState } from '../shared/types'

/** preload 暴露给渲染层的受限 API 类型定义 */
export interface RendererApi {
  /** 当前操作系统平台 */
  platform: NodeJS.Platform
  /** 运行时版本（只读） */
  versions: {
    electron: string
    chrome: string
    node: string
  }
  /** IPC 通道名常量（只读引用） */
  channels: typeof IPC_CHANNELS
  /** IPC 事件通道名常量（只读引用） */
  events: typeof IPC_EVENTS
  /** 白名单守卫的统一 IPC 调用入口 */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** 订阅主进程事件（白名单守卫），返回取消订阅函数 */
  on<T = unknown>(channel: string, listener: (payload: T) => void): () => void

  /** B 站模式（WBI 搜索 / 播放窗口 / 悬浮面板 / 导航判定） */
  bili: {
    search(keyword: string, options?: Partial<BiliSearchOptions>): Promise<BiliSearchResponse>
    openVideo(payload: OpenVideoPayload): Promise<void>
    closeVideo(): Promise<void>
    videoState(): Promise<VideoState>
    getContext(): Promise<BiliContext | null>
    overlaySetSize(size: OverlaySize): Promise<void>
    overlaySetState(state: OverlayState): Promise<OverlaySnapshot>
    overlayGetState(): Promise<OverlaySnapshot>
    overlayToggleHide(): Promise<OverlaySnapshot>
    /** 渲染层指针拖拽：按增量移动悬浮面板窗口（球态 / 面板态均可移动） */
    overlayMoveBy(dx: number, dy: number): Promise<void>
    navCheck(url: string): Promise<NavVerdict>
    resetWbi(): Promise<void>
    markRelevant(payload: MarkRelevantPayload): Promise<boolean>
    /** 时间点标记跳转：让视频窗口 seek 到指定进度（F-2） */
    seekTo(payload: SeekToPayload): Promise<boolean>
    /** 读取视频当前播放位置（秒，标准 HTML5 API） */
    getVideoPosition(): Promise<number>
  }

  /** 记事本（增量 upsert + 分视频归档） */
  notes: {
    save(entries: NoteEntry[]): Promise<void>
    load(): Promise<NoteEntry[]>
    /** 单条增量保存（P-1：不再整份覆盖） */
    upsert(entry: NoteEntry): Promise<NoteEntry>
    /** 按 id 删除单条 */
    delete(id: string): Promise<void>
    /** 按视频归档读取 */
    loadByVideo(bvid: string): Promise<NoteEntry[]>
  }

  /** 按视频学习进度（F-3） */
  playRecords: {
    /** 会话心跳累计观看时长 / 播放位置 */
    tick(tick: PlayRecordTick): Promise<PlayRecord | null>
    /** 全部进度列表 */
    list(): Promise<PlayRecord[]>
    /** 标记某视频已学完 */
    markDone(bvid: string): Promise<PlayRecord | null>
    /** 学习目标设定（F-5） */
    setGoal(bvid: string, goalRounds: number, goalDeadline?: string): Promise<PlayRecord | null>
  }

  /** 用户反馈（R-1） */
  feedback: {
    submit(payload: {
      mode: string
      rating: number
      category?: string
      detail?: string
    }): Promise<FeedbackEntry | null>
    list(): Promise<FeedbackEntry[]>
    stats(): Promise<FeedbackStats>
  }

  /** 学习会话计时（B 站学习 / 英语学习模式） */
  session: {
    start(options: SessionStartOptions): Promise<SessionState>
    stop(): Promise<SessionState>
    pause(): Promise<SessionState>
    resume(): Promise<SessionState>
    getState(): Promise<SessionState>
  }

  /** 白噪音（主进程侧：素材信息） */
  audio: {
    getAssets(): Promise<AssetInfo[]>
  }

  /** 全局设置（electron-store，即时生效） */
  settings: {
    get(): Promise<AppSettings>
    set(entries: Record<string, unknown>): Promise<AppSettings>
  }

  /** 学习统计 */
  stats: {
    dayTrend(days: number): Promise<DayTrendPoint[]>
    modeCompare(): Promise<ModeStat[]>
    heatmap(): Promise<HeatmapCell[]>
    homeSummary(): Promise<HomeSummary>
  }

  /** 紧急退出（恢复码 bcrypt） */
  emergency: {
    exit(code: string): Promise<EmergencyExitResult>
    setCode(code: string): Promise<boolean>
  }

  /** AI 网关 */
  ai: {
    /** B 站学习助手：完整回复（携带学习上下文与多轮历史） */
    ask(request: AiAskRequest): Promise<AiReply>
    /** B 站学习助手：流式问答（增量经 ai:chunk 事件推送，requestId 关联；F-4/P-2） */
    biliAsk(request: AiAskRequest): Promise<AiReply>
    /** 英语模式：流式问答（增量经 ai:chunk 事件推送） */
    englishAsk(question: AiQuestion): Promise<EnglishAiReply>
    /** LLM 配置（BYOK，只读；写入走 设置页 settings:set） */
    getConfig(): Promise<AiConfig>
    /** 会话提问用量 */
    usage(): Promise<AiUsage>
    /** 图片文字识别（OCR 模型） */
    ocr(req: OcrRequest): Promise<OcrResult>
    /** 生词本 */
    addVocab(payload: AddVocabPayload): Promise<VocabEntry>
    listVocab(): Promise<VocabEntry[]>
    deleteVocab(id: number): Promise<boolean>
    /** 语法要点 */
    addGrammar(payload: AddGrammarPayload): Promise<GrammarPoint>
    listGrammar(): Promise<GrammarPoint[]>
    deleteGrammar(id: number): Promise<boolean>
  }
}

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}
