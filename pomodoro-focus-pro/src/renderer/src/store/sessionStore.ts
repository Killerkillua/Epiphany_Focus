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
  start: (mode: SessionMode, durationMs: number) => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  clearCompleted: () => void
}

let subscribed = false

export const useSessionStore = create<SessionStore>((set) => ({
  mode: 'english',
  snapshot: DEFAULT_SNAPSHOT,
  justCompleted: false,

  init: async () => {
    if (!subscribed) {
      subscribed = true
      window.api.on<TimerSnapshot>('session:tick', (snap) => set({ snapshot: snap }))
      window.api.on<TimerSnapshot>('session:complete', (snap) =>
        set({ snapshot: snap, justCompleted: true })
      )
    }
    const state = await window.api.session.getState()
    set({ mode: state.mode, snapshot: state.timer })
  },

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
