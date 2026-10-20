import { create } from 'zustand'
import type { SessionMode, TimerSnapshot } from '../../../shared/types'

/**
 * 学习会话计时状态（渲染层，B 站学习 / 英语学习模式共用）。
 * 权威计时状态在主进程 SessionTimerService，本 store 通过 IPC 同步快照。
 * 与 focusStore 的区别：不触发强制引擎（锁屏 / 遮罩 / 快捷键拦截）。
 */

const MINUTE = 60 * 1000

const DEFAULT_SNAPSHOT: TimerSnapshot = {
  mode: 'countdown',
  status: 'idle',
  durationMs: 60 * MINUTE,
  elapsedMs: 0,
  remainingMs: 60 * MINUTE,
  completedPomodoros: 0,
  longRestSuggestion: false
}

interface SessionStore {
  /** 当前学习会话模式（bili / english） */
  mode: SessionMode
  /** 主进程计时快照 */
  snapshot: TimerSnapshot
  /** 刚完成一段学习会话（触发提示音 / 通知） */
  justCompleted: boolean
  /** 初始化：订阅事件 + 拉取当前状态 */
  init: () => Promise<void>
  /** 取消全部 IPC 事件订阅（HMR 热替换 / 窗口销毁时清理） */
  destroy: () => void
  start: (mode: SessionMode, durationMs: number) => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  clearCompleted: () => void
}

/**
 * CR-07：订阅生命周期管理（同 focusStore）。
 * globalThis 持久标志防 HMR 重复订阅；destroy() 统一取消订阅句柄。
 */
const g = globalThis as unknown as { __pomodoroSessionEventsSubscribed?: boolean }
let unsubscribeFns: Array<() => void> = []

function unsubscribeAll(): void {
  for (const fn of unsubscribeFns) fn()
  unsubscribeFns = []
  g.__pomodoroSessionEventsSubscribed = false
}

// HMR：模块被热替换前先取消订阅 + 复位标志，新模块实例可干净地重新订阅
if (import.meta.hot) {
  import.meta.hot.dispose(() => unsubscribeAll())
}

export const useSessionStore = create<SessionStore>((set) => ({
  mode: 'english',
  snapshot: DEFAULT_SNAPSHOT,
  justCompleted: false,

  init: async () => {
    if (!g.__pomodoroSessionEventsSubscribed) {
      g.__pomodoroSessionEventsSubscribed = true
      unsubscribeFns.push(
        window.api.on<TimerSnapshot>(window.api.events.session.tick, (snap) =>
          set({ snapshot: snap })
        ),
        window.api.on<TimerSnapshot>(window.api.events.session.complete, (snap) =>
          set({ snapshot: snap, justCompleted: true })
        )
      )
    }
    const state = await window.api.session.getState()
    set({ mode: state.mode, snapshot: state.timer })
  },

  destroy: unsubscribeAll,

  start: async (mode, durationMs) => {
    const state = await window.api.session.start({ mode, durationMs })
    set({ mode: state.mode, snapshot: state.timer, justCompleted: false })
  },

  pause: async () => {
    const state = await window.api.session.pause()
    set({ snapshot: state.timer })
  },

  resume: async () => {
    const state = await window.api.session.resume()
    set({ snapshot: state.timer })
  },

  stop: async () => {
    const state = await window.api.session.stop()
    set({ snapshot: state.timer })
  },

  clearCompleted: () => set({ justCompleted: false })
}))
