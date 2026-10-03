import type { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import type {
  AiAskRequest,
  BiliAiReply,
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
  AiReply,
  AiUsage,
  GrammarPoint,
  OcrRequest,
  OcrResult,
  VocabEntry
} from '../shared/ai'
import type { AssetInfo } from '../shared/audio'
import type { AppSettings, EmergencyExitResult } from '../shared/settings'
import type {
  DailyStat,
  DayTrendPoint,
  FeedbackEntry,
  FeedbackStats,
  HeatmapCell,
  HomeSummary,
  ModeStat,
  PlayRecord,
  PlayRecordTick,
  PlayRecordUpdate,
  ProgressFilter,
  ProgressStats,
  StudySession
} from '../shared/stats'
import type { BackupMeta, ImportPreview } from '../shared/backup'
import type {
  DistractionPolicy,
  SessionStartOptions,
  SessionState,
  TimerOptions,
  TimerSnapshot
} from '../shared/types'

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
  /** 订阅主进程事件（白名单守卫），返回取消订阅函数 */
  on<T = unknown>(channel: string, listener: (payload: T) => void): () => void

  /** 番茄钟计时（专注模式，联动强制引擎） */
  timer: {
    getState(): Promise<TimerSnapshot>
    start(options: TimerOptions): Promise<TimerSnapshot>
    pause(): Promise<TimerSnapshot>
    resume(): Promise<TimerSnapshot>
    stop(): Promise<TimerSnapshot>
  }

  /** 强制引擎（窗口行为 / 分心拦截策略） */
  enforce: {
    setAlwaysOnTop(on: boolean): Promise<boolean>
    applyDistractionPolicy(policy: DistractionPolicy): Promise<DistractionPolicy>
  }

  /** 视频学习模式（WBI 搜索 / 播放窗口 / 悬浮面板 / 导航判定） */
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
    navCheck(url: string): Promise<NavVerdict>
    resetWbi(): Promise<void>
    markRelevant(payload: MarkRelevantPayload): Promise<boolean>
    /** 时间点标记跳转：让视频窗口 seek 到指定进度（F-2） */
    seekTo(payload: SeekToPayload): Promise<boolean>
    /** 读取视频当前播放位置（秒，标准 HTML5 API） */
    getVideoPosition(): Promise<number>
    /** 读取视频总时长（秒，标准 HTML5 API；进度百分比与"回到上次位置"用） */
    getVideoDuration(): Promise<number>
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

  /** 按视频学习进度（F-3 / M1 管理 / M2 快捷访问 / M3 统计） */
  playRecords: {
    /** 会话心跳累计观看时长 / 播放位置 */
    tick(tick: PlayRecordTick): Promise<PlayRecord | null>
    /** 全部进度列表 */
    list(): Promise<PlayRecord[]>
    /** 标记某视频已学完 */
    markDone(bvid: string): Promise<PlayRecord | null>
    /** 学习目标设定（F-5） */
    setGoal(bvid: string, goalRounds: number, goalDeadline?: string): Promise<PlayRecord | null>
    /** 单条进度读取 */
    get(bvid: string): Promise<PlayRecord | null>
    /** 删除单条学习记录（默认不级联删笔记） */
    delete(bvid: string, opts?: { deleteNotes?: boolean }): Promise<boolean>
    /** 批量删除（事务原子） */
    batchDelete(bvids: string[]): Promise<number>
    /** 修改学习记录（已观看时长 / 位置 / 状态 / 观看次数 / 目标等） */
    update(bvid: string, updates: PlayRecordUpdate): Promise<PlayRecord | null>
    /** 批量修改（批量改状态等） */
    batchUpdate(bvids: string[], updates: PlayRecordUpdate): Promise<number>
    /** 多维度筛选 + 排序 */
    search(filter: ProgressFilter): Promise<PlayRecord[]>
    /** 设置标签（整体替换） */
    setTags(bvid: string, tags: string[]): Promise<PlayRecord | null>
    /** 全部标签（筛选下拉用） */
    getTags(): Promise<string[]>
    /** 概览统计（今日/本周/本月/streak/课程计数/全局目标） */
    getStats(): Promise<ProgressStats>
    /** 某视频的学习会话明细 */
    getSessions(bvid: string, limit?: number): Promise<StudySession[]>
    /** 近 N 天每日学习时长（M4 柱状图） */
    getDailyStats(days: number): Promise<DailyStat[]>
    /** 手动备份：主进程弹保存对话框 → 写 JSON（M5） */
    exportData(): Promise<{
      ok: boolean
      canceled?: boolean
      filePath?: string
      recordCount?: number
      error?: string
    }>
    /** 选择备份文件 + 解析校验，返回恢复预览（M5） */
    importPreview(): Promise<{
      ok: boolean
      canceled?: boolean
      filePath?: string
      preview?: ImportPreview
      error?: string
    }>
    /** 执行恢复（merge / replace，M5） */
    importData(
      filePath: string,
      mode: 'merge' | 'replace'
    ): Promise<{ ok: boolean; records: number; notes: number; sessions: number; error?: string }>
    /** 备份元数据列表（M5） */
    listBackups(): Promise<BackupMeta[]>
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

  /** 学习会话计时（视频学习 / 英语学习模式） */
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
    /** 选择备份目录（M5；取消返回 null） */
    pickBackupDir(): Promise<string | null>
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
    /** 设置/修改恢复码（已设置过时必须携带旧码验证；强制会话中禁止修改） */
    setCode(code: string, oldCode?: string): Promise<boolean>
    /** 紧急退出弹窗期间暂停窗口守卫失焦拉回（避免视频窗口抢焦点，输入不了恢复码） */
    setPullBackPaused(paused: boolean): Promise<void>
  }

  /** AI 网关 */
  ai: {
    /** 视频学习助手：完整回复（携带学习上下文与多轮历史） */
    ask(request: AiAskRequest): Promise<BiliAiReply>
    /** 视频学习助手：流式问答（增量经 ai:chunk 事件推送，requestId 关联；F-4/P-2） */
    biliAsk(request: AiAskRequest): Promise<BiliAiReply>
    /** 英语模式：流式问答（增量经 ai:chunk 事件推送） */
    englishAsk(question: AiQuestion): Promise<AiReply>
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
