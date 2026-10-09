import type { BiliStrictness, EndAction, LockLevel } from '../../../../shared/settings'

/** 设置页扁平表单快照（与 electron-store 各分组的映射见 useSettingsLoader） */
export interface LocalForm {
  lockLevel: LockLevel
  endAction: EndAction
  sessionMaxHours: number
  sessionOverlay: boolean
  focusMin: number
  shortBreakMin: number
  longBreakMin: number
  longBreakEvery: number
  strictness: BiliStrictness
  autoFullscreen: boolean
  baseURL: string
  apiKey: string
  model: string
  ocrModel: string
  maxQuestionsPerSession: number
  noisePreset: string
  hasCode: boolean
  telemetryEnabled: boolean
  // M5 自动备份
  backupEnabled: boolean
  backupFrequency: 'daily' | 'weekly'
  backupTime: string
  backupKeepCount: number
  backupDirectory: string
  launchAtLogin: boolean
}

export const EMPTY: LocalForm = {
  lockLevel: 'L1',
  endAction: 'overlay',
  sessionMaxHours: 4,
  sessionOverlay: true,
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  strictness: 'standard',
  autoFullscreen: true,
  baseURL: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'Qwen/Qwen3.5-4B',
  ocrModel: 'Qwen/Qwen3.5-4B',
  maxQuestionsPerSession: 50,
  noisePreset: 'rain',
  hasCode: false,
  telemetryEnabled: false,
  backupEnabled: true,
  backupFrequency: 'daily',
  backupTime: '03:00',
  backupKeepCount: 7,
  backupDirectory: '',
  launchAtLogin: false
}

export const NOISE_OPTIONS = [
  { value: 'white', label: '白噪' },
  { value: 'pink', label: '粉噪' },
  { value: 'brown', label: '棕噪' },
  { value: 'rain', label: '雨声' },
  { value: 'cafe', label: '咖啡厅' },
  { value: 'forest', label: '森林' },
  { value: 'library', label: '图书馆' },
  { value: 'waves', label: '海浪' },
  { value: 'fire', label: '篝火' },
  { value: 'fan', label: '风扇' },
  { value: 'birds', label: '鸟鸣' }
]

/** 保存一组设置（点路径写入 electron-store）并刷新快照 */
export type UpdateFn = (entries: Record<string, unknown>, tip?: string) => Promise<void>
