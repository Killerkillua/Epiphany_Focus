import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS, isAllowedEvent } from '../shared/ipc'
import type { RendererApi } from './index.d'
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
  AddVocabResult,
  UpdateVocabPayload,
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
  StudyReviewTotals,
  PlayRecord,
  PlayRecordTick,
  PlayRecordUpdate,
  ProgressFilter,
  ProgressStats,
  StudySession
} from '../shared/stats'
import type { BackupMeta, ImportPreview } from '../shared/backup'
import type { ExportFileResult, StatsExportFormat, VocabExportFormat } from '../shared/export'
import type {
  AuthResult,
  AuthState,
  AuthUser,
  DeleteAccountPayload,
  LoginPayload,
  RegisterPayload,
  ResetPasswordPayload
} from '../shared/auth'
import type {
  DistractionPolicy,
  SessionStartOptions,
  SessionState,
  TimerOptions,
  TimerSnapshot
} from '../shared/types'
import type { Task, TaskDraft, TaskFilter, TaskPatch, TaskReview, TaskStatus } from '../shared/task'
import type { LocalMediaPickResult, OpenWebStudyPayload, SiteRulePreview } from '../shared/study'

/**
 * preload：通过 contextBridge 向渲染层暴露受限 API。
 * 只暴露命名方法（CR-06：移除通用 invoke 通道，渲染层只能调用白名单内
 * 的类型化 API，preload 作为安全屏障不被绕过），不暴露任何 node/electron 能力。
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

  /* ===== 番茄钟计时（专注模式，联动强制引擎） ===== */
  timer: {
    getState: (): Promise<TimerSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.timer.getState) as Promise<TimerSnapshot>,
    start: (options: TimerOptions): Promise<TimerSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.timer.start, options) as Promise<TimerSnapshot>,
    pause: (): Promise<TimerSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.timer.pause) as Promise<TimerSnapshot>,
    resume: (): Promise<TimerSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.timer.resume) as Promise<TimerSnapshot>,
    stop: (): Promise<TimerSnapshot> =>
      ipcRenderer.invoke(IPC_CHANNELS.timer.stop) as Promise<TimerSnapshot>
  },

  /* ===== 强制引擎（窗口行为 / 分心拦截策略） ===== */
  enforce: {
    setAlwaysOnTop: (on: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.enforce.setAlwaysOnTop, on) as Promise<boolean>,
    applyDistractionPolicy: (policy: DistractionPolicy): Promise<DistractionPolicy> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.enforce.applyDistractionPolicy,
        policy
      ) as Promise<DistractionPolicy>
  },

  /* ===== 视频学习模式 ===== */
  bili: {
    search: (keyword: string, options?: Partial<BiliSearchOptions>): Promise<BiliSearchResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.search, keyword, options) as Promise<BiliSearchResponse>,
    openVideo: (payload: OpenVideoPayload): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.openVideo, payload) as Promise<void>,
    closeVideo: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.closeVideo) as Promise<void>,
    videoState: (): Promise<VideoState> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.videoState) as Promise<VideoState>,
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
      ipcRenderer.invoke(IPC_CHANNELS.bili.getVideoPosition) as Promise<number>,
    getVideoDuration: (): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.bili.getVideoDuration) as Promise<number>
  },

  /** 本地视频与白名单学习网站 */
  study: {
    pickLocal: (): Promise<LocalMediaPickResult & { token?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.study.pickLocal) as Promise<
        LocalMediaPickResult & { token?: string }
      >,
    openLocal: (payload: {
      token: string
      resourceKey: string
      title: string
      autoFullscreen: boolean
      topic?: string
      plannedMs?: number
      seekSeconds?: number
    }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.study.openLocal, payload) as Promise<void>,
    openWeb: (payload: OpenWebStudyPayload): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.study.openWeb, payload) as Promise<void>,
    resume: (recordId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.study.resume, recordId) as Promise<void>,
    previewSite: (payload: {
      text: string
      pathPrefixes?: string[]
      label?: string
    }): Promise<SiteRulePreview> =>
      ipcRenderer.invoke(IPC_CHANNELS.study.previewSite, payload) as Promise<SiteRulePreview>
  },

  /* ===== 学习会话计时（视频学习 / 英语模式） ===== */
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
    load: (): Promise<NoteEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.notes.load) as Promise<NoteEntry[]>,
    upsert: (entry: NoteEntry): Promise<NoteEntry> =>
      ipcRenderer.invoke(IPC_CHANNELS.notes.upsert, entry) as Promise<NoteEntry>,
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.notes.delete, id) as Promise<void>,
    loadByVideo: (bvid: string): Promise<NoteEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.notes.loadByVideo, bvid) as Promise<NoteEntry[]>
  },

  export: {
    stats: (payload: { format: StatsExportFormat }): Promise<ExportFileResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.export.stats, payload) as Promise<ExportFileResult>,
    notesMarkdown: (): Promise<ExportFileResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.export.notesMarkdown) as Promise<ExportFileResult>,
    vocab: (payload: { format: VocabExportFormat }): Promise<ExportFileResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.export.vocab, payload) as Promise<ExportFileResult>
  },

  /* ===== 按视频学习进度（F-3 / M1 管理 / M2 快捷访问 / M3 统计） ===== */
  playRecords: {
    tick: (tick: PlayRecordTick): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.tick, tick) as Promise<PlayRecord | null>,
    list: (): Promise<PlayRecord[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.list) as Promise<PlayRecord[]>,
    markDone: (bvid: string): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.markDone, bvid) as Promise<PlayRecord | null>,
    setGoal: (
      bvid: string,
      goalRounds: number,
      goalDeadline?: string
    ): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.setGoal, {
        bvid,
        goalRounds,
        goalDeadline
      }) as Promise<PlayRecord | null>,
    get: (bvid: string): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.get, bvid) as Promise<PlayRecord | null>,
    delete: (bvid: string, opts?: { deleteNotes?: boolean }): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.delete, bvid, opts) as Promise<boolean>,
    batchDelete: (bvids: string[]): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.batchDelete, bvids) as Promise<number>,
    update: (bvid: string, updates: PlayRecordUpdate): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.playRecords.update,
        bvid,
        updates
      ) as Promise<PlayRecord | null>,
    batchUpdate: (bvids: string[], updates: PlayRecordUpdate): Promise<number> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.batchUpdate, bvids, updates) as Promise<number>,
    search: (filter: ProgressFilter): Promise<PlayRecord[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.search, filter) as Promise<PlayRecord[]>,
    setTags: (bvid: string, tags: string[]): Promise<PlayRecord | null> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.playRecords.setTags,
        bvid,
        tags
      ) as Promise<PlayRecord | null>,
    getTags: (): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.getTags) as Promise<string[]>,
    getStats: (): Promise<ProgressStats> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.getStats) as Promise<ProgressStats>,
    getSessions: (bvid: string, limit?: number): Promise<StudySession[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.getSessions, bvid, limit) as Promise<
        StudySession[]
      >,
    /** 近 N 天每日学习时长（M4 柱状图） */
    getDailyStats: (days: number): Promise<DailyStat[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.getDailyStats, days) as Promise<DailyStat[]>,
    /** 手动备份：主进程弹保存对话框 → 写 JSON（M5） */
    exportData: (): Promise<{
      ok: boolean
      canceled?: boolean
      filePath?: string
      recordCount?: number
      error?: string
    }> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.exportData) as Promise<{
        ok: boolean
        canceled?: boolean
        filePath?: string
        recordCount?: number
        error?: string
      }>,
    /** 选择备份文件 + 解析校验，返回恢复预览（M5） */
    importPreview: (): Promise<{
      ok: boolean
      canceled?: boolean
      filePath?: string
      preview?: ImportPreview
      error?: string
    }> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.importPreview) as Promise<{
        ok: boolean
        canceled?: boolean
        filePath?: string
        preview?: ImportPreview
        error?: string
      }>,
    /** 执行恢复（merge / replace，M5） */
    importData: (
      filePath: string,
      mode: 'merge' | 'replace'
    ): Promise<{
      ok: boolean
      records: number
      notes: number
      sessions: number
      tasks?: number
      error?: string
    }> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.importData, filePath, mode) as Promise<{
        ok: boolean
        records: number
        notes: number
        sessions: number
        tasks?: number
        error?: string
      }>,
    /** 备份元数据列表（M5） */
    listBackups: (): Promise<BackupMeta[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.playRecords.listBackups) as Promise<BackupMeta[]>
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
      ipcRenderer.invoke(IPC_CHANNELS.audio.getAssets) as Promise<AssetInfo[]>,
    getBuffer: (key: string): Promise<Uint8Array | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.audio.getBuffer, key) as Promise<Uint8Array | null>
  },

  /* ===== 全局设置（electron-store，即时生效） ===== */
  settings: {
    get: (): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settings.get) as Promise<AppSettings>,
    set: (entries: Record<string, unknown>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settings.set, entries) as Promise<AppSettings>,
    /** 选择备份目录（M5；取消返回 null） */
    pickBackupDir: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.settings.pickBackupDir) as Promise<string | null>,
    /** 打开系统日志目录 */
    openLogDir: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.settings.openLogDir) as Promise<string>,
    /** 获取系统日志文件路径 */
    getLogPath: (): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.settings.getLogPath) as Promise<string>
  },

  /* ===== 任务清单 ===== */
  tasks: {
    list: (filter?: TaskFilter): Promise<Task[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.list, filter ?? {}) as Promise<Task[]>,
    create: (draft: TaskDraft): Promise<Task> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.create, draft) as Promise<Task>,
    update: (id: string, patch: TaskPatch): Promise<Task> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.update, id, patch) as Promise<Task>,
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.delete, id) as Promise<boolean>,
    setStatus: (id: string, status: TaskStatus): Promise<Task> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.setStatus, id, status) as Promise<Task>,
    review: (): Promise<TaskReview> =>
      ipcRenderer.invoke(IPC_CHANNELS.tasks.review) as Promise<TaskReview>
  },

  /* ===== 专注打扰 ===== */
  interruptions: {
    add: (payload: {
      type: 'internal' | 'external'
      note?: string
    }): Promise<{
      eventId: string
      snapshot: TimerSnapshot
    }> =>
      ipcRenderer.invoke(IPC_CHANNELS.interruptions.add, payload) as Promise<{
        eventId: string
        snapshot: TimerSnapshot
      }>,
    updateNote: (id: string, note: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.interruptions.updateNote, id, note) as Promise<boolean>
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
      ipcRenderer.invoke(IPC_CHANNELS.stats.homeSummary) as Promise<HomeSummary>,
    review: (): Promise<StudyReviewTotals> =>
      ipcRenderer.invoke(IPC_CHANNELS.stats.review) as Promise<StudyReviewTotals>
  },

  /* ===== 本地账号 ===== */
  auth: {
    getState: (): Promise<AuthState> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.getState) as Promise<AuthState>,
    register: (p: RegisterPayload): Promise<AuthResult<{ user: AuthUser; recoveryCode: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.register, p) as Promise<
        AuthResult<{ user: AuthUser; recoveryCode: string }>
      >,
    login: (p: LoginPayload): Promise<AuthResult<{ user: AuthUser }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.login, p) as Promise<AuthResult<{ user: AuthUser }>>,
    loginGuest: (): Promise<AuthResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.loginGuest) as Promise<AuthResult>,
    logout: (): Promise<AuthResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.logout) as Promise<AuthResult>,
    changePassword: (oldPassword: string, newPassword: string): Promise<AuthResult> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.auth.changePassword,
        oldPassword,
        newPassword
      ) as Promise<AuthResult>,
    updateNickname: (nickname: string): Promise<AuthResult<{ user: AuthUser }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.updateNickname, nickname) as Promise<
        AuthResult<{ user: AuthUser }>
      >,
    deleteAccount: (p: DeleteAccountPayload): Promise<AuthResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.deleteAccount, p) as Promise<AuthResult>,
    resetPassword: (p: ResetPasswordPayload): Promise<AuthResult<{ recoveryCode: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.auth.resetPassword, p) as Promise<
        AuthResult<{ recoveryCode: string }>
      >
  },

  /* ===== 紧急退出 ===== */
  emergency: {
    exit: (code: string): Promise<EmergencyExitResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.emergency.exit, code) as Promise<EmergencyExitResult>,
    /** 设置/修改恢复码（已设置过时必须验证账户密码；强制会话中禁止修改） */
    setCode: (code: string, password?: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.emergency.setCode, code, password) as Promise<boolean>,
    /** 紧急退出弹窗期间暂停窗口守卫失焦拉回（避免视频窗口抢焦点，输入不了恢复码） */
    setPullBackPaused: (paused: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.emergency.setPullBackPaused, paused) as Promise<void>
  },

  /* ===== AI 网关 ===== */
  ai: {
    ask: (request: AiAskRequest): Promise<BiliAiReply> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.ask, request) as Promise<BiliAiReply>,

    /** 视频学习助手：流式问答（增量经 ai:chunk 事件推送，requestId 关联；F-4/P-2） */
    biliAsk: (request: AiAskRequest): Promise<BiliAiReply> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.biliAsk, request) as Promise<BiliAiReply>,

    /* ===== 英语学习模式 ===== */
    englishAsk: (question: AiQuestion): Promise<AiReply> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.englishAsk, question) as Promise<AiReply>,

    getConfig: (): Promise<AiConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.getConfig) as Promise<AiConfig>,

    ping: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.ping) as Promise<{ ok: boolean; message: string }>,

    abort: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.abort, requestId) as Promise<void>,

    usage: (): Promise<AiUsage> => ipcRenderer.invoke(IPC_CHANNELS.ai.usage) as Promise<AiUsage>,

    /* 图片文字识别（OCR 模型） */
    ocr: (req: OcrRequest): Promise<OcrResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.ocr, req) as Promise<OcrResult>,

    /* 生词本 */
    addVocab: (payload: AddVocabPayload): Promise<AddVocabResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.addVocab, payload) as Promise<AddVocabResult>,
    listVocab: (): Promise<VocabEntry[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.listVocab) as Promise<VocabEntry[]>,
    updateVocab: (payload: UpdateVocabPayload): Promise<VocabEntry> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.updateVocab, payload) as Promise<VocabEntry>,
    deleteVocab: (id: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.deleteVocab, id) as Promise<boolean>,

    /* 语法要点 */
    addGrammar: (payload: AddGrammarPayload): Promise<GrammarPoint> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.addGrammar, payload) as Promise<GrammarPoint>,
    listGrammar: (): Promise<GrammarPoint[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.listGrammar) as Promise<GrammarPoint[]>,
    deleteGrammar: (id: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.ai.deleteGrammar, id) as Promise<boolean>
  },

  app: {
    isPackaged: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.app.isPackaged) as Promise<boolean>
  },

  /* 窗口控制（自定义标题栏） */
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.window.minimize),
    maximize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.window.maximize),
    close: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.window.close),
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.window.isMaximized) as Promise<boolean>
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
