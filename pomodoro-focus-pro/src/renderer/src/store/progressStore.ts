import { create } from 'zustand'
import type {
  DailyStat,
  PlayRecord,
  PlayRecordUpdate,
  ProgressFilter,
  ProgressStats
} from '../../../shared/stats'

/**
 * 学习进度状态（M1/M2/M3，替代 OverlayApp 内联 useReducer 的进度部分）。
 * - 两个入口（悬浮面板 / 学习助手抽屉）各进程一份实例，数据同源（SQLite）
 * - records = 筛选后的列表（search IPC，SQL 侧筛选排序）；all = 未筛选全量（续学卡片/当前视频）
 * - selection / selectMode 承载批量操作（M1）
 */
export const DEFAULT_FILTER: ProgressFilter = {
  keyword: '',
  status: 'all',
  tags: [],
  dateRange: null,
  sortBy: 'updated_at',
  sortOrder: 'desc'
}

/** 列表内 upsert 一条记录（tick / 修改 / 目标保存后本地即时生效，避免整表重查） */
function upsertInto(list: PlayRecord[], rec: PlayRecord): PlayRecord[] {
  const i = list.findIndex((r) => r.bvid === rec.bvid)
  if (i < 0) return [rec, ...list]
  const next = list.slice()
  next[i] = rec
  return next
}

interface ProgressState {
  /** 筛选后的记录列表（列表区渲染） */
  records: PlayRecord[]
  /** 未筛选全量（续学卡片 / 当前视频查找） */
  all: PlayRecord[]
  /** 概览统计 */
  stats: ProgressStats | null
  /** 全部标签（筛选下拉 / 标签输入补全） */
  allTags: string[]
  /** 每日学习时长（M4 柱状图，近 dailyDays 天） */
  dailyStats: DailyStat[]
  /** 柱状图窗口天数（7 / 30） */
  dailyDays: number
  /** 当前筛选条件 */
  filter: ProgressFilter
  /** 批量选择的 bvid 集合 */
  selection: string[]
  /** 是否处于批量选择模式 */
  selectMode: boolean
  loading: boolean

  /** 全量加载（列表 + 统计 + 标签 + 每日时长），入口打开 / bvid 切换时调用 */
  load(): Promise<void>
  /** 仅按当前筛选重查列表 */
  refreshRecords(): Promise<void>
  /** 仅刷新概览统计 */
  refreshStats(): Promise<void>
  /** 加载每日学习时长（切换 7/30 天窗口） */
  loadDailyStats(days: number): Promise<void>
  /** 合并更新筛选条件并重查列表 */
  setFilter(patch: Partial<ProgressFilter>): void
  /** 会话心跳落库后的本地即时更新（不重查） */
  applyTick(rec: PlayRecord): void
  /** 标记学完 */
  markDone(bvid: string): Promise<void>
  /** 设置课程目标（精读遍数 + 截止日期） */
  setGoal(bvid: string, goalRounds: number, goalDeadline?: string): Promise<void>
  /** 删除（单条走 delete，多条走 batchDelete；删除后退出选择模式由调用方处理） */
  removeRecords(bvids: string[]): Promise<void>
  /** 修改单条（调整进度对话框） */
  updateRecord(bvid: string, updates: PlayRecordUpdate): Promise<void>
  /** 批量修改（批量改状态等） */
  updateRecords(bvids: string[], updates: PlayRecordUpdate): Promise<void>
  /** 设置标签（整体替换） */
  setTags(bvid: string, tags: string[]): Promise<void>
  toggleSelect(bvid: string): void
  /** 全选当前列表 / 已全选则取消 */
  selectAll(): void
  clearSelection(): void
  /** 进入/退出批量选择模式（进入时清空旧选择） */
  setSelectMode(on: boolean): void
}

export const useProgressStore = create<ProgressState>((set, get) => ({
  records: [],
  all: [],
  stats: null,
  allTags: [],
  dailyStats: [],
  dailyDays: 7,
  filter: DEFAULT_FILTER,
  selection: [],
  selectMode: false,
  loading: false,

  load: async () => {
    set({ loading: true })
    try {
      const [all, records, stats, allTags, dailyStats] = await Promise.all([
        window.api.playRecords.list(),
        window.api.playRecords.search(get().filter),
        window.api.playRecords.getStats(),
        window.api.playRecords.getTags(),
        window.api.playRecords.getDailyStats(get().dailyDays)
      ])
      set({ all, records, stats, allTags, dailyStats })
    } catch (err) {
      console.error('[progress] 加载学习进度失败:', err)
    } finally {
      set({ loading: false })
    }
  },

  refreshRecords: async () => {
    try {
      const records = await window.api.playRecords.search(get().filter)
      set({ records })
    } catch (err) {
      console.error('[progress] 刷新列表失败:', err)
    }
  },

  refreshStats: async () => {
    try {
      const stats = await window.api.playRecords.getStats()
      set({ stats })
    } catch (err) {
      console.error('[progress] 刷新统计失败:', err)
    }
  },

  loadDailyStats: async (days) => {
    try {
      const [dailyStats, stats] = await Promise.all([
        window.api.playRecords.getDailyStats(days),
        window.api.playRecords.getStats()
      ])
      set({ dailyStats, dailyDays: days, stats })
    } catch (err) {
      console.error('[progress] 加载每日时长失败:', err)
    }
  },

  setFilter: (patch) => {
    set({ filter: { ...get().filter, ...patch } })
    void get().refreshRecords()
  },

  applyTick: (rec) => {
    set((s) => ({
      all: upsertInto(s.all, rec),
      records: upsertInto(s.records, rec)
    }))
  },

  markDone: async (bvid) => {
    const rec = await window.api.playRecords.markDone(bvid)
    if (rec) {
      set((s) => ({ all: upsertInto(s.all, rec), records: upsertInto(s.records, rec) }))
      void get().refreshStats()
    }
  },

  setGoal: async (bvid, goalRounds, goalDeadline) => {
    const rec = await window.api.playRecords.setGoal(bvid, goalRounds, goalDeadline)
    if (rec) {
      set((s) => ({ all: upsertInto(s.all, rec), records: upsertInto(s.records, rec) }))
      void get().refreshStats()
    }
  },

  removeRecords: async (bvids) => {
    const list = [...new Set((bvids ?? []).filter(Boolean))]
    if (list.length === 0) return
    if (list.length === 1) await window.api.playRecords.delete(list[0])
    else await window.api.playRecords.batchDelete(list)
    set((s) => ({
      all: s.all.filter((r) => !list.includes(r.bvid)),
      records: s.records.filter((r) => !list.includes(r.bvid)),
      selection: s.selection.filter((b) => !list.includes(b))
    }))
    void get().refreshStats()
  },

  updateRecord: async (bvid, updates) => {
    const rec = await window.api.playRecords.update(bvid, updates)
    if (rec) {
      set((s) => ({ all: upsertInto(s.all, rec), records: upsertInto(s.records, rec) }))
      void get().refreshStats()
    }
  },

  updateRecords: async (bvids, updates) => {
    const list = [...new Set((bvids ?? []).filter(Boolean))]
    if (list.length === 0) return
    if (list.length === 1) await window.api.playRecords.update(list[0], updates)
    else await window.api.playRecords.batchUpdate(list, updates)
    await get().refreshRecords()
    void get().refreshStats()
  },

  setTags: async (bvid, tags) => {
    const rec = await window.api.playRecords.setTags(bvid, tags)
    if (rec) {
      set((s) => ({ all: upsertInto(s.all, rec), records: upsertInto(s.records, rec) }))
    }
    const allTags = await window.api.playRecords.getTags()
    set({ allTags })
  },

  toggleSelect: (bvid) => {
    set((s) => ({
      selection: s.selection.includes(bvid)
        ? s.selection.filter((b) => b !== bvid)
        : [...s.selection, bvid]
    }))
  },

  selectAll: () => {
    set((s) => {
      const ids = s.records.map((r) => r.bvid)
      const allSelected = ids.length > 0 && ids.every((b) => s.selection.includes(b))
      return {
        selection: allSelected
          ? s.selection.filter((b) => !ids.includes(b))
          : [...new Set([...s.selection, ...ids])]
      }
    })
  },

  clearSelection: () => set({ selection: [] }),

  setSelectMode: (on) => set({ selectMode: on, selection: [] })
}))
