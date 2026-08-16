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
  start: (mode: TimerMode, durationMs: number) => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  setAlwaysOnTop: (on: boolean) => Promise<void>
  setDistraction: (patch: Partial<DistractionPolicy>) => Promise<void>
  clearCompleted: () => void
}

let subscribed = false

export const useFocusStore = create<FocusStore>((set, get) => ({
  snapshot: DEFAULT_SNAPSHOT,
  alwaysOnTop: false,
  distraction: DEFAULT_DISTRACTION,
  justCompleted: false,

  init: async () => {
    if (!subscribed) {
      subscribed = true
      window.api.on<TimerSnapshot>('timer:tick', (snap) => set({ snapshot: snap }))
      window.api.on<TimerSnapshot>('timer:complete', (snap) =>
        set({ snapshot: snap, justCompleted: true })
      )
    }
    const snap = await window.api.invoke<TimerSnapshot>('timer:get-state')
    set({ snapshot: snap })
  },

  start: async (mode, durationMs) => {
    const snap = await window.api.invoke<TimerSnapshot>('timer:start', { mode, durationMs })
    set({ snapshot: snap, justCompleted: false, alwaysOnTop: true })
  },

  pause: async () => {
    const snap = await window.api.invoke<TimerSnapshot>('timer:pause')
    set({ snapshot: snap })
  },

  resume: async () => {
    const snap = await window.api.invoke<TimerSnapshot>('timer:resume')
    set({ snapshot: snap })
  },

  stop: async () => {
    const snap = await window.api.invoke<TimerSnapshot>('timer:stop')
    set({ snapshot: snap, alwaysOnTop: false })
  },

  setAlwaysOnTop: async (on) => {
    await window.api.invoke<boolean>('enforce:set-always-on-top', on)
    set({ alwaysOnTop: on })
  },

  setDistraction: async (patch) => {
    const next = { ...get().distraction, ...patch }
    await window.api.invoke<DistractionPolicy>('enforce:apply-distraction-policy', next)
    set({ distraction: next })
  },

  clearCompleted: () => set({ justCompleted: false })
}))
