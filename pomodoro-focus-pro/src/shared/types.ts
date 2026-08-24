/**
 * 主进程 / preload / 渲染层共享的类型定义。
 * 只放纯类型，不含任何实现。
 */

/** 计时方式：逆序（倒计时） / 正序（累加） */
export type TimerMode = 'countdown' | 'countup'

/** 计时状态 */
export type TimerStatus = 'idle' | 'running' | 'paused' | 'finished'

/** timer:start 参数 */
export interface TimerOptions {
  mode: TimerMode
  /** 逆序计时的目标时长（毫秒）；正序计时忽略 */
  durationMs: number
}

/** 计时器快照（主进程权威状态，经 IPC 下发给渲染层） */
export interface TimerSnapshot {
  mode: TimerMode
  status: TimerStatus
  /** 逆序计时目标时长（毫秒） */
  durationMs: number
  /** 当前已用时长（毫秒，单调时钟） */
  elapsedMs: number
  /** 剩余时长（毫秒，countdown 有效） */
  remainingMs: number
  /** 已完成番茄数（距上次长休息，0-3；满 4 归零） */
  completedPomodoros: number
  /** 本轮完成后是否触发长休息建议（仅 complete 事件携带） */
  longRestSuggestion: boolean
}

/** 分心应用拦截策略 */
export interface DistractionPolicy {
  /** 是否启用拦截 */
  enabled: boolean
  /** 黑名单：命中前台窗口即强制结束（进程名，不含 .exe，小写） */
  blacklist: string[]
  /** 白名单：豁免（优先于黑名单） */
  whitelist: string[]
}

/** 学习会话模式：B 站学习 / 英语学习（与专注模式解耦的轻量计时） */
export type SessionMode = 'bili' | 'english'

/** session:start 参数 */
export interface SessionStartOptions {
  mode: SessionMode
  /** 会话时长（毫秒，倒计时） */
  durationMs: number
}

/** 学习会话状态（get-state 返回：模式 + 计时快照） */
export interface SessionState {
  mode: SessionMode
  timer: TimerSnapshot
}
