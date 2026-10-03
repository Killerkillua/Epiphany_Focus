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
  /** 导航管控（视频学习模式） */
  nav: {
    check: 'nav:check'
  },
  /** 视频学习模式（WBI 搜索 / 播放窗口 / 悬浮面板 / 导航判定） */
  bili: {
    search: 'bili:search',
    openVideo: 'bili:open-video',
    closeVideo: 'bili:close-video',
    videoState: 'bili:video-state',
    getContext: 'bili:get-context',
    overlaySetSize: 'bili:overlay-set-size',
    navCheck: 'bili:nav-check',
    resetWbi: 'bili:reset-wbi',
    markRelevant: 'bili:mark-relevant'
  },
  /** AI 网关 */
  ai: {
    /** 视频学习 overlay 兼容：单轮完整回复 */
    ask: 'ai:ask',
    /** 兼容：一次性返回整段文本 */
    stream: 'ai:stream',
    /** 英语模式：流式问答（增量经 ai:chunk 事件推送） */
    englishAsk: 'ai:english-ask',
    /** 图片文字识别（硅基流动 DeepSeek-OCR） */
    ocr: 'ai:ocr',
    /** LLM 配置（BYOK） */
    getConfig: 'ai:get-config',
    setConfig: 'ai:set-config',
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
  /** 记事本 */
  notes: {
    save: 'notes:save',
    load: 'notes:load'
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
  /** 视频学习模式事件（播放窗口 / 导航拦截） */
  bili: {
    videoOpened: 'bili:video-opened',
    videoClosed: 'bili:video-closed',
    navBlocked: 'bili:nav-blocked'
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
