import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../ipc'
import { getDayTrend, getDb, getHomeSummary, getHourHeatmap, getModeCompare } from './db'
import type { DayTrendPoint, HeatmapCell, HomeSummary, ModeStat } from '../../shared/stats'

/**
 * 学习统计 IPC（从 study_stats / sessions 聚合，方案 3.4）。
 */

/** SQLite 不可用（加载失败）时向渲染层显式抛错：UI 展示错误态而非空白数据 */
function requireDb(): void {
  if (!getDb()) {
    throw new Error('本地数据库不可用，学习统计暂不可用')
  }
}

export function registerStatsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.stats.dayTrend, (_event, days: number): DayTrendPoint[] => {
    requireDb()
    return getDayTrend(typeof days === 'number' ? days : 14)
  })

  ipcMain.handle(IPC_CHANNELS.stats.modeCompare, (): ModeStat[] => {
    requireDb()
    return getModeCompare()
  })

  ipcMain.handle(IPC_CHANNELS.stats.heatmap, (): HeatmapCell[] => {
    requireDb()
    return getHourHeatmap()
  })

  ipcMain.handle(IPC_CHANNELS.stats.homeSummary, (): HomeSummary => {
    requireDb()
    return getHomeSummary()
  })
}
