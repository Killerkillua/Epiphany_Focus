import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS, isAllowedChannel, isAllowedEvent } from '../main/ipc'
import type { RendererApi } from './index.d'
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
import type { SessionStartOptions, SessionState, TimerSnapshot } from '../shared/types'

/**
 * preload：通过 contextBridge 向渲染层暴露受限 API。
 * 骨架阶段只暴露只读运行时信息 + 白名单守卫的 invoke 封装，
 * 不暴露任何 node/electron 能力；业务通道处理器接入后，
 * invoke 即成为统一的调用入口。
 */
const api: RendererApi = {
  /** 只读运行时信息（同步，无需 IPC） */
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  },
  /** 通道名常量（只读引用，供渲染层类型化使用） */
  channels: IPC_CHANNELS,
  /** 事件通道名常量（只读引用，供 on() 订阅使用） */
  events: IPC_EVENTS,

  /**
   * 统一的 IPC 调用入口（白名单守卫）。
   * 骨架阶段主进程尚未注册业务处理器，调用会以
   * "No handler registered" 报错——属预期行为，
   * 用于验证传输链路；接入业务模块后即正常。
   */
  invoke: async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    if (!isAllowedChannel(channel)) {
      throw new Error(`[preload] 通道不在白名单内: ${channel}`)
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<T>
  },

  /**
   * 订阅主进程事件（白名单守卫），返回取消订阅函数。
   * 仅允许 IPC_EVENTS 中声明的事件通道。
   */
  on: <T = unknown>(channel: string, listener: (payload: T) => void): (() => void) => {
    if (!isAllowedEvent(channel)) {
      throw new Error(`[preload] 事件通道不在白名单内: ${channel}`)
    }
    const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },

  /* ===== B 站模式 ===== */
  bili: {
    search: (keyword: string, options?: Partial<BiliSearchOptions>): Promise<BiliSearchResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.search, keyword, options) as Promise<BiliSearchResponse>,
    openVideo: (payload: OpenVideoPayload): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.openVideo, payload) as Promise<void>,
    closeVideo: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.bili.closeVideo) as Promise<void>,
    videoState: (): Promise<VideoState> => ipcRenderer.invoke(IPC_CHANNELS.bili.videoState) as Promise<VideoState>,
    getContext: (): Promise<BiliContext | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.getContext) as Promise<BiliContext | null>,
    overlaySetSize: (size: OverlaySize): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.overlaySetSize, size) as Promise<void>,
    overlaySetState: (state: OverlayState): Promise<OverlaySnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.overlaySetState, state) as Promise<OverlaySnapshot>,
    overlayGetState: (): Promise<OverlaySnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.overlayGetState) as Promise<OverlaySnapshot>,
    overlayToggleHide: (): Promise<OverlaySnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.overlayToggleHide) as Promise<OverlaySnapshot>,
    navCheck: (url: string): Promise<NavVerdict> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.navCheck, url) as Promise<NavVerdict>,
    resetWbi: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.bili.resetWbi) as Promise<void>,
    markRelevant: (payload: MarkRelevantPayload): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.markRelevant, payload) as Promise<boolean>,
    seekTo: (payload: SeekToPayload): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.seekTo, payload) as Promise<boolean>,
    getVideoPosition: (): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.getVideoPosition) as Promise<number>
  },

  /* ===== 学习会话计时（B 站 / 英语模式） ===== */
  session: {
    start: (options: SessionStartOptions): Promise<SessionState> =>
      ipcRenderer.invoke(IPC_CHANNELS.session.start, options) as Promise<SessionState>,
    stop: (): Promise<SessionState> =>
      ipcRenderer.invoke(IPC_CHANNELS.session.stop) as Promise<SessionState>,
    pause: (): Promise<SessionState> =>
      ipcRenderer.invoke(IPC_CHANNELS.session.pause) as Promise<SessionState>,
    resume: (): Promise<SessionState> =>
      ipcRenderer.invoke(IPC_CHANNELS.session.resume) as Promise<SessionState>,
    getState: (): Promise<SessionState> =>
      ipcRenderer.invoke(IPC_CHANNELS.session.getState) as Promise<SessionState>
  },

  /* ===== 记事本（增量 upsert + 分视频归档） ===== */
  notes: {
    save: (entries: NoteEntry[]): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.notes.save, entries) as Promise<void>,
    load: (): Promise<NoteEntry[]> => ipcRenderer.invoke(IPC_CHANNELS.notes.load) as Promise<NoteEntry[]>,
    upsert: (entry: NoteEntry): Promise<NoteEntry> =>
      ipcRenderer.invoke(IPC_CHANNELS.notes.upsert, entry) as Promise<NoteEntry>,
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.notes.delete, id) as Promise<void>,
    loadByVideo: (bvid: string): Promise<NoteEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.notes.loadByVideo, bvid) as Promise<NoteEntry[]>
  },

  /* ===== 按视频学习进度（F-3） ===== */
  playRecords: {
    tick: (tick: PlayRecordTick): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.tick, tick) as Promise<PlayRecord | null>,
    list: (): Promise<PlayRecord[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.list) as Promise<PlayRecord[]>,
    markDone: (bvid: string): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.markDone, bvid) as Promise<PlayRecord | null>,
    setGoal: (bvid: string, goalRounds: number, goalDeadline?: string): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.setGoal, {
        bvid,
        goalRounds,
        goalDeadline
      }) as Promise<PlayRecord | null>
  },

  /* ===== 用户反馈（R-1） ===== */
  feedback: {
    submit: (payload: {
      mode: string
      rating: number
      category?: string
      detail?: string
    }): Promise<FeedbackEntry | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.feedback.submit, payload) as Promise<FeedbackEntry | null>,
    list: (): Promise<FeedbackEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.feedback.list) as Promise<FeedbackEntry[]>,
    stats: (): Promise<FeedbackStats> =>
      ipcRenderer.invoke(IPC_CHANNELS.feedback.stats) as Promise<FeedbackStats>
  },

  /* ===== 白噪音 ===== */
  audio: {
    getAssets: (): Promise<AssetInfo[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.audio.getAssets) as Promise<AssetInfo[]>
  },

  /* ===== 全局设置（electron-store，即时生效） ===== */
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC_CHANNELS.settings.get) as Promise<AppSettings>,
    set: (entries: Record<string, unknown>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settings.set, entries) as Promise<AppSettings>
  },

  /* ===== 学习统计 ===== */
  stats: {
    dayTrend: (days: number): Promise<DayTrendPoint[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.stats.dayTrend, days) as Promise<DayTrendPoint[]>,
    modeCompare: (): Promise<ModeStat[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.stats.modeCompare) as Promise<ModeStat[]>,
    heatmap: (): Promise<HeatmapCell[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.stats.heatmap) as Promise<HeatmapCell[]>,
    homeSummary: (): Promise<HomeSummary> =>
      ipcRenderer.invoke(IPC_CHANNELS.stats.homeSummary) as Promise<HomeSummary>
  },

  /* ===== 紧急退出 ===== */
  emergency: {
    exit: (code: string): Promise<EmergencyExitResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.emergency.exit, code) as Promise<EmergencyExitResult>,
    setCode: (code: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.emergency.setCode, code) as Promise<boolean>,
    /** 紧急退出弹窗期间暂停窗口守卫失焦拉回（避免视频窗口抢焦点，输入不了恢复码） */
    setPullBackPaused: (paused: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.emergency.setPullBackPaused, paused) as Promise<void>
  },

  /* ===== AI 网关 ===== */
  ai: {
    ask: (request: AiAskRequest): Promise<AiReply> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.ask, request) as Promise<AiReply>,

    /** B 站学习助手：流式问答（增量经 ai:chunk 事件推送，requestId 关联；F-4/P-2） */
    biliAsk: (request: AiAskRequest): Promise<AiReply> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.biliAsk, request) as Promise<AiReply>,

    /* ===== 英语学习模式 ===== */
    englishAsk: (question: AiQuestion): Promise<EnglishAiReply> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.englishAsk, question) as Promise<EnglishAiReply>,

    getConfig: (): Promise<AiConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.getConfig) as Promise<AiConfig>,

    usage: (): Promise<AiUsage> => ipcRenderer.invoke(IPC_CHANNELS.ai.usage) as Promise<AiUsage>,

    /* 图片文字识别（OCR 模型） */
    ocr: (req: OcrRequest): Promise<OcrResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.ocr, req) as Promise<OcrResult>,

    /* 生词本 */
    addVocab: (payload: AddVocabPayload): Promise<VocabEntry> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.addVocab, payload) as Promise<VocabEntry>,
    listVocab: (): Promise<VocabEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.listVocab) as Promise<VocabEntry[]>,
    deleteVocab: (id: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.deleteVocab, id) as Promise<boolean>,

    /* 语法要点 */
    addGrammar: (payload: AddGrammarPayload): Promise<GrammarPoint> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.addGrammar, payload) as Promise<GrammarPoint>,
    listGrammar: (): Promise<GrammarPoint[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.listGrammar) as Promise<GrammarPoint[]>,
    deleteGrammar: (id: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.deleteGrammar, id) as Promise<boolean>
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] exposeInMainWorld 失败:', error)
  }
} else {
  // 未开启 contextIsolation 时的兜底（本工程默认开启，不会走到这里）
  ;(globalThis as unknown as { api: RendererApi }).api = api
}
