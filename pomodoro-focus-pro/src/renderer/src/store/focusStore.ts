import { create } from 'zustand'
import type { DistractionPolicy, TimerMode, TimerSnapshot } from '../../../shared/types'

/**
 * 专注模式状态（渲染层）。
 * 权威计时状态在主进程 TimerService，本 store 通过 IPC 同步快照。
 */

const MINUTE = 60 * 1000

const DEFAULT_SNAPSHOT: TimerSnapshot = {
  mode: 'countdown',
  status: 'idle',
  durationMs: 25 * MINUTE,
  elapsedMs: 0,
  remainingMs: 25 * MINUTE,
  completedPomodoros: 0,
  longRestSuggestion: false
}

const DEFAULT_DISTRACTION: DistractionPolicy = {
  enabled: false,
  blacklist: [],
  whitelist: []
}

interface FocusStore {
  /** 主进程计时快照 */
  snapshot: TimerSnapshot
  /** 窗口置顶状态 */
  alwaysOnTop: boolean
  /** 分心应用拦截策略 */
  distraction: DistractionPolicy
  /** 刚完成一段番茄（触发提示音/通知） */
  justCompleted: boolean
  /** 初始化：订阅事件 + 拉取当前状态 */
  init: () => Promise<void>
  /** 取消全部 IPC 事件订阅（HMR 热替换 / 窗口销毁时清理） */
  destroy: () => void
  start: (mode: TimerMode, durationMs: number) => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  setAlwaysOnTop: (on: boolean) => Promise<void>
  setDistraction: (patch: Partial<DistractionPolicy>) => Promise<void>
  clearCompleted: () => void
}

/**
 * CR-07：订阅生命周期管理。
 * - 模块级 subscribed 标志在 HMR 热更新时会重置（模块重新执行）导致重复订阅，
 *   改用 globalThis 持久标志防重；
 * - 订阅句柄统一收进 unsubscribeFns，destroy() 一次性取消，
 *   避免 timer:tick（每秒）/ timer:complete 高频事件在热更新或多窗口下泄漏。
 */
const g = globalThis as unknown as { __pomodoroFocusEventsSubscribed?: boolean }
let unsubscribeFns: Array<() => void> = []

function unsubscribeAll(): void {
  for (const fn of unsubscribeFns) fn()
  unsubscribeFns = []
  g.__pomodoroFocusEventsSubscribed = false
}

// HMR：模块被热替换前先取消订阅 + 复位标志，新模块实例可干净地重新订阅
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribeAll())
}

export const useFocusStore = create<FocusStore>((set, get) => ({
  snapshot: DEFAULT_SNAPSHOT,
  alwaysOnTop: false,
  distraction: DEFAULT_DISTRACTION,
  justCompleted: false,

  init: async () => {
    if (!g.__pomodoroFocusEventsSubscribed) {
      g.__pomodoroFocusEventsSubscribed = true
      unsubscribeFns.push(
        window.api.on<TimerSnapshot>(window.api.events.timer.tick, (snap) =>
          set({ snapshot: snap })
        ),
        window.api.on<TimerSnapshot>(window.api.events.timer.complete, (snap) =>
          set({ snapshot: snap, justCompleted: true })
        )
      )
    }
    const snap = await window.api.timer.getState()
    set({ snapshot: snap })
  },

  destroy: unsubscribeAll,

  start: async (mode, durationMs) => {
    const snap = await window.api.timer.start({ mode, durationMs })
    set({ snapshot: snap, justCompleted: false, alwaysOnTop: true })
  },

  pause: async () => {
    const snap = await window.api.timer.pause()
    set({ snapshot: snap })
  },

  resume: async () => {
    const snap = await window.api.timer.resume()
    set({ snapshot: snap })
  },

  stop: async () => {
    const snap = await window.api.timer.stop()
    set({ snapshot: snap, alwaysOnTop: false })
  },

  setAlwaysOnTop: async (on) => {
    await window.api.enforce.setAlwaysOnTop(on)
    set({ alwaysOnTop: on })
  },

  setDistraction: async (patch) => {
    const next = { ...get().distraction, ...patch }
    await window.api.enforce.applyDistractionPolicy(next)
    set({ distraction: next })
  },

  clearCompleted: () => set({ justCompleted: false })
}))
