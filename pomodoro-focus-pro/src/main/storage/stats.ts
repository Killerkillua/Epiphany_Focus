import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../ipc'
import { getDayTrend, getHomeSummary, getHourHeatmap, getModeCompare } from './db'
import type { DayTrendPoint, HeatmapCell, HomeSummary, ModeStat } from '../../shared/stats'

/**
 * 学习统计 IPC（从 study_stats / sessions 聚合，方案 3.4）。
 */

export function registerStatsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.stats.dayTrend, (_event, days: number): DayTrendPoint[] => {
    return getDayTrend(typeof days === 'number' ? days : 14)
  })

  ipcMain.handle(IPC_CHANNELS.stats.modeCompare, (): ModeStat[] => getModeCompare())

  ipcMain.handle(IPC_CHANNELS.stats.heatmap, (): HeatmapCell[] => getHourHeatmap())

  ipcMain.handle(IPC_CHANNELS.stats.homeSummary, (): HomeSummary => getHomeSummary())
}
