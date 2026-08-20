/**
 * IPC 通道声明。
 * 仅包含通道名常量与白名单，不含任何业务实现。
 * - IPC_CHANNELS：渲染层 invoke 通道（经 preload 白名单守卫）
 * - IPC_EVENTS  ：主进程 → 渲染层事件通道（经 preload on() 白名单守卫）
 */

export const IPC_CHANNELS = {
  /** 番茄钟计时 */
  timer: {
    start: 'timer:start',
    stop: 'timer:stop',
    pause: 'timer:pause',
    resume: 'timer:resume',
    getState: 'timer:get-state'
  },
  /** 模式进入/退出 */
  mode: {
    enter: 'mode:enter',
    exit: 'mode:exit'
  },
  /** 学习会话计时（B 站学习 / 英语学习，与强制引擎解耦） */
  session: {
    start: 'session:start',
    stop: 'session:stop',
    pause: 'session:pause',
    resume: 'session:resume',
    getState: 'session:get-state'
  },
  /** 导航管控（B 站模式） */
  nav: {
    check: 'nav:check'
  },
  /** B 站模式（WBI 搜索 / 播放窗口 / 悬浮面板 / 导航判定） */
  bili: {
    search: 'bili:search',
    openVideo: 'bili:open-video',
    closeVideo: 'bili:close-video',
    videoState: 'bili:video-state',
    getContext: 'bili:get-context',
    overlaySetSize: 'bili:overlay-set-size',
    /** 悬浮面板状态机切换（expanded/collapsed/minimized/hidden） */
    overlaySetState: 'bili:overlay-set-state',
    /** 获取悬浮面板当前状态快照 */
    overlayGetState: 'bili:overlay-get-state',
    /** 快捷键呼出 / 隐藏悬浮面板 */
    overlayToggleHide: 'bili:overlay-toggle-hide',
    /** 渲染层指针拖拽：按增量移动悬浮面板窗口（可移动悬浮球 / 可移动面板） */
    overlayMoveBy: 'bili:overlay-move-by',
    navCheck: 'bili:nav-check',
    resetWbi: 'bili:reset-wbi',
    markRelevant: 'bili:mark-relevant',
    /** 时间点标记跳转：让视频窗口 seek 到指定进度（F-2） */
    seekTo: 'bili:seek-to',
    /** 读取视频当前播放位置（秒，HTML5 video.currentTime，标准 API） */
    getVideoPosition: 'bili:get-video-position'
  },
  /** AI 网关 */
  ai: {
    /** B 站 overlay 兼容：单轮完整回复 */
    ask: 'ai:ask',
    /** 兼容：一次性返回整段文本 */
    stream: 'ai:stream',
    /** B 站学习助手：流式问答（增量经 ai:chunk 事件推送，requestId 关联；F-4/P-2） */
    biliAsk: 'ai:bili-ask',
    /** 英语模式：流式问答（增量经 ai:chunk 事件推送） */
    englishAsk: 'ai:english-ask',
    /** 图片文字识别（OCR 模型） */
    ocr: 'ai:ocr',
    /** LLM 配置（BYOK，只读；写入走 settings:set） */
    getConfig: 'ai:get-config',
    /** 会话提问用量 */
    usage: 'ai:usage',
    /** 生词本 */
    addVocab: 'ai:add-vocab',
    listVocab: 'ai:list-vocab',
    deleteVocab: 'ai:delete-vocab',
    /** 语法要点 */
    addGrammar: 'ai:add-grammar',
    listGrammar: 'ai:list-grammar',
    deleteGrammar: 'ai:delete-grammar'
  },
  /** 记事本（增量 upsert + 按视频归档） */
  notes: {
    save: 'notes:save',
    load: 'notes:load',
    /** 单条增量保存（P-1：不再整份覆盖） */
    upsert: 'notes:upsert',
    /** 按 id 删除单条 */
    delete: 'notes:delete',
    /** 按视频归档读取 */
    loadByVideo: 'notes:load-by-video'
  },
  /** 按视频学习进度（F-3） */
  playRecords: {
    /** 会话心跳累计观看时长 / 播放位置 */
    tick: 'play-records:tick',
    /** 全部进度列表 */
    list: 'play-records:list',
    /** 标记某视频已学完 */
    markDone: 'play-records:mark-done',
    /** 学习目标设定（F-5） */
    setGoal: 'play-records:set-goal'
  },
  /** 用户反馈（R-1） */
  feedback: {
    submit: 'feedback:submit',
    list: 'feedback:list',
    stats: 'feedback:stats'
  },
  /** 匿名遥测（R-2，opt-in） */
  telemetry: {
    record: 'telemetry:record'
  },
  /** 白噪音（主进程侧：素材信息；混音引擎在渲染层） */
  audio: {
    /** 采样素材信息（路径 + 存在性） */
    getAssets: 'audio:get-assets'
  },
  /** 强制引擎 */
  enforce: {
    lock: 'enforce:lock',
    unlock: 'enforce:unlock',
    /** 窗口置顶开关（L0/L1：置顶不强制全屏） */
    setAlwaysOnTop: 'enforce:set-always-on-top',
    /** 应用分心应用黑/白名单拦截策略 */
    applyDistractionPolicy: 'enforce:apply-distraction-policy'
  },
  /** 紧急退出 */
  emergency: {
    exit: 'emergency:exit',
    /** 设置/修改紧急恢复码 */
    setCode: 'emergency:set-code'
  },
  /** 学习统计（study_stats / sessions 聚合） */
  stats: {
    /** 日趋势（近 N 天） */
    dayTrend: 'stats:day-trend',
    /** 模式对比 */
    modeCompare: 'stats:mode-compare',
    /** 时段热力图（星期 × 小时） */
    heatmap: 'stats:heatmap',
    /** 首页聚合汇总（今日专注 / 完成番茄 / 连续天数） */
    homeSummary: 'stats:home-summary'
  },
  /** 全局设置（electron-store，即时生效） */
  settings: {
    get: 'settings:get',
    set: 'settings:set'
  },
  /** 应用级信息 */
  app: {
    getVersion: 'app:get-version',
    platform: 'app:platform'
  }
} as const

export type IpcChannelGroup = keyof typeof IPC_CHANNELS

/** 主进程 → 渲染层事件通道（不可 invoke，只能 on） */
export const IPC_EVENTS = {
  timer: {
    /** 每秒推送计时快照 */
    tick: 'timer:tick',
    /** 计时完成（到点 / 正序手动结束） */
    complete: 'timer:complete'
  },
  /** 学习会话计时事件（B 站 / 英语模式） */
  session: {
    /** 每秒推送会话计时快照 */
    tick: 'session:tick',
    /** 会话到点完成 */
    complete: 'session:complete'
  },
  /** B 站模式事件（播放窗口 / 导航拦截 / 悬浮面板状态） */
  bili: {
    videoOpened: 'bili:video-opened',
    videoClosed: 'bili:video-closed',
    navBlocked: 'bili:nav-blocked',
    /** 悬浮面板状态变化广播（主进程 → overlay / 主窗口） */
    overlayStateChanged: 'bili:overlay-state-changed'
  },
  /** AI 事件 */
  ai: {
    /** 流式回复增量（携带 requestId） */
    chunk: 'ai:chunk'
  },
  /** 白噪音事件 */
  audio: {
    /** 全局热键 Ctrl+Shift+↑/↓ 触发，携带 { delta } 音量步进 */
    volumeChanged: 'audio:volume-changed'
  },
  /** 全局设置事件 */
  settings: {
    /** 设置变更广播（settings:set / ai 配置写入后推送最新快照，渲染层据此实时刷新） */
    changed: 'settings:changed'
  }
} as const

/** 扁平化全部 invoke 通道名（白名单） */
export const IPC_WHITELIST: readonly string[] = Object.values(IPC_CHANNELS).flatMap(
  (group) => Object.values(group)
)

/** 扁平化全部事件通道名（白名单） */
export const IPC_EVENT_WHITELIST: readonly string[] = Object.values(IPC_EVENTS).flatMap(
  (group) => Object.values(group)
)

/** 校验 invoke 通道名是否在声明白名单内 */
export function isAllowedChannel(channel: string): boolean {
  return IPC_WHITELIST.includes(channel)
}

/** 校验事件通道名是否在声明白名单内 */
export function isAllowedEvent(channel: string): boolean {
  return IPC_EVENT_WHITELIST.includes(channel)
}
