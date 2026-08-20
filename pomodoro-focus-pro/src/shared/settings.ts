/**
 * 全局设置类型（方案 4.2 默认值）。
 * 轻量配置统一存 electron-store（userData/settings.json）。
 */

/** 锁定强度分级（方案 2.5）：L0 置顶提醒 / L1 标准 / L2 强化守护 */
export type LockLevel = 'L0' | 'L1' | 'L2'

/** 到点动作：锁屏 / 全屏遮罩 / 仅提示 */
export type EndAction = 'lock' | 'overlay' | 'notify'

/** B 站内容相关度档位（方案 2.6） */
export type BiliStrictness = 'strict' | 'standard' | 'loose'

export interface PomodoroSettings {
  /** 专注时长（分钟），默认 25 */
  focusMin: number
  /** 短休息（分钟），默认 5 */
  shortBreakMin: number
  /** 长休息（分钟），默认 15 */
  longBreakMin: number
  /** 长休息间隔（个番茄），默认 4 */
  longBreakEvery: number
}

export interface BiliSettings {
  strictness: BiliStrictness
  /** 点击视频自动全屏 */
  autoFullscreen: boolean
}

export interface AiSettings {
  /** OpenAI 兼容端点 */
  baseURL: string
  /** BYOK；空 = 演示模式 */
  apiKey: string
  /** 对话模型名 */
  model: string
  /** 单会话提问上限 */
  maxQuestionsPerSession: number
  /** OCR 模型名（如 Qwen/Qwen3.5-4B） */
  ocrModel: string
}

/** 强制会话持久化状态（重启恢复，方案 2.5 L2） */
export interface EnforcedState {
  active: boolean
  level: LockLevel
  mode: string
  startedAt: number
  plannedMs: number
  sessionId: number
}

export interface AppSettings {
  lockLevel: LockLevel
  pomodoro: PomodoroSettings
  endAction: EndAction
  /** 会话时长上限（小时），默认 4，防止误锁过久 */
  sessionMaxHours: number
  /** 学习会话全屏遮罩（英语 / B 站计时开始后对主窗口施加与专注模式一致的遮罩；默认开启） */
  sessionOverlay: boolean
  bili: BiliSettings
  ai: AiSettings
  /** 白噪音预设 key（audio 模块清单） */
  noisePreset: string
  /** 紧急恢复码 bcrypt 哈希（仅存哈希，不可逆） */
  recoveryCodeHash: string | null
  /** 强制会话持久化状态 */
  enforced: EnforcedState | null
  /**
   * 匿名使用统计（R-2）：默认关闭；开启后仅记录本地计数/时长事件
   * （打开视频数、会话时长、提问数、导航拦截次数、面板显隐次数），
   * 不上送任何内容 / URL / 笔记文本，可随时一键关闭。
   */
  telemetryEnabled: boolean
}

/** 紧急退出结果 */
export interface EmergencyExitResult {
  ok: boolean
  error?: string
  /** 冷却剩余秒数（失败时） */
  retryInSec?: number
}

/** 方案 4.2 默认值 */
export const SETTINGS_DEFAULTS: AppSettings = {
  lockLevel: 'L1',
  pomodoro: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4 },
  endAction: 'overlay',
  sessionMaxHours: 4,
  sessionOverlay: true,
  bili: { strictness: 'standard', autoFullscreen: true },
  ai: {
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen3.5-4B',
    maxQuestionsPerSession: 50,
    ocrModel: 'Qwen/Qwen3.5-4B'
  },
  noisePreset: 'rain',
  recoveryCodeHash: null,
  enforced: null,
  telemetryEnabled: false
}
