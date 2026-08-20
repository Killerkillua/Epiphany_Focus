import { create } from 'zustand'
import type { DayTrendPoint, HeatmapCell, HomeSummary, ModeStat } from '../../../shared/stats'

/**
 * 学习统计统一状态（重构后 StatsBar / StatsPage 共用）：
 * - 缓存：趋势按天数粒度缓存（trendDays），模式/热力图全量缓存，命中缓存不重复请求
 * - 实时刷新：订阅 timer:complete / session:complete，统计页打开时自动刷新，
 *   未打开时仅失效缓存，下次进入再拉取
 * - 错误态：数据库不可用等加载失败写入 error，UI 展示显式提示而非空白
 */

interface StatsState {
  /** 日趋势（trendDays 记录当前已加载的天数粒度） */
  trend: DayTrendPoint[]
  trendDays: number | null
  /** 模式对比（null = 未加载 / 已失效） */
  modes: ModeStat[] | null
  /** 时段热力图（null = 未加载 / 已失效） */
  heatmap: HeatmapCell[] | null
  /** 首页聚合汇总（今日专注 / 完成番茄 / 连续天数） */
  summary: HomeSummary | null
  /** 统计页加载中（页面级 Spin） */
  loading: boolean
  /** 最近一次加载错误（数据库不可用等） */
  error: string | null
  /** 统计页当前是否挂载：挂载时完成事件触发全量刷新，否则仅失效缓存 */
  pageActive: boolean
  setPageActive: (active: boolean) => void
  /** 加载统计页全部数据（命中缓存的部分不请求） */
  loadAll: (days: number) => Promise<void>
  /** 加载首页汇总（静默，不触发 loading） */
  loadSummary: () => Promise<void>
  /** 番茄/学习会话完成后的统一刷新入口（事件订阅调用） */
  onStudyCompleted: () => void
  clearError: () => void
}

export const useStatsStore = create<StatsState>((set, get) => {
  const clearError = (): void => {
    if (get().error) set({ error: null })
  }

  const loadSummary = async (): Promise<void> => {
    try {
      const summary = await window.api.stats.homeSummary()
      set({ summary })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '首页统计加载失败' })
    }
  }

  const loadAll = async (days: number): Promise<void> => {
    const s = get()
    const needTrend = s.trendDays !== days
    const needModes = s.modes === null
    const needHeatmap = s.heatmap === null
    // 全部命中缓存：直接使用，不发请求
    if (!needTrend && !needModes && !needHeatmap) return
    set({ loading: true })
    clearError()
    try {
      const [trend, modes, heatmap] = await Promise.all([
        needTrend ? window.api.stats.dayTrend(days) : Promise.resolve(s.trend),
        needModes ? window.api.stats.modeCompare() : Promise.resolve(s.modes),
        needHeatmap ? window.api.stats.heatmap() : Promise.resolve(s.heatmap)
      ])
      set({ trend, trendDays: days, modes, heatmap, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '统计数据加载失败', loading: false })
    }
  }

  const onStudyCompleted = (): void => {
    const s = get()
    // 首页统计条：静默刷新（不触发 loading，避免闪烁）
    void loadSummary()
    if (s.pageActive) {
      // 统计页打开中：全量刷新（趋势复用当前天数粒度）
      void loadAll(s.trendDays ?? 14)
    } else {
      // 统计页未打开：仅失效缓存，下次进入再拉取最新数据
      set({ trendDays: null, modes: null, heatmap: null })
    }
  }

  return {
    trend: [],
    trendDays: null,
    modes: null,
    heatmap: null,
    summary: null,
    loading: false,
    error: null,
    pageActive: false,
    setPageActive: (active) => set({ pageActive: active }),
    loadAll,
    loadSummary,
    onStudyCompleted,
    clearError
  }
})

/**
 * 应用生命周期内订阅一次完成事件：番茄 / 学习会话结束后自动刷新统计。
 * （HMR 防重：模块重新执行时不重复订阅）
 */
const g = globalThis as unknown as { __statsEventsSubscribed?: boolean }
if (!g.__statsEventsSubscribed) {
  g.__statsEventsSubscribed = true
  window.api.on(window.api.events.timer.complete, () => {
    useStatsStore.getState().onStudyCompleted()
  })
  window.api.on(window.api.events.session.complete, () => {
    useStatsStore.getState().onStudyCompleted()
  })
}
