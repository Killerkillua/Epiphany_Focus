import { DEFAULT_NOISE_SETTINGS } from '../../../shared/audio'
import type { NoiseSettings } from '../../../shared/audio'

/**
 * 白噪音设置持久化（M1 用 localStorage；后续 storage 模块接入后迁移 electron-store）。
 */

const STORAGE_KEY = 'noise.settings'

export function loadSettings(): NoiseSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_NOISE_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<NoiseSettings>
    return { ...DEFAULT_NOISE_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_NOISE_SETTINGS }
  }
}

export function saveSettings(settings: NoiseSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* 存储不可用时静默 */
  }
}
