import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { message } from 'antd'
import type { BackupMeta } from '../../../../shared/backup'
import { EMPTY, type LocalForm, type UpdateFn } from './types'

export interface SettingsLoader {
  /** 当前设置快照（读取→修改→保存→刷新 的"读取/刷新"结果） */
  form: LocalForm
  setForm: Dispatch<SetStateAction<LocalForm>>
  /** 保存中标志（禁用全部控件） */
  saving: boolean
  /** M5 最近备份列表（前 5 条） */
  backups: BackupMeta[]
  /** 重新读取设置 + 最近备份 */
  load: () => Promise<void>
  /** 仅刷新最近备份列表（导出成功后调用） */
  refreshBackups: () => Promise<void>
  /** 通用保存：写 electron-store → 提示 → 重新加载快照 */
  update: UpdateFn
}

/**
 * 设置页数据加载器：统一封装 loadSettings / 当前快照 / 保存后刷新，
 * 消除各分组重复的 "保存 → 重新加载" 模式（问题 H-10）。
 */
export function useSettingsLoader(): SettingsLoader {
  const [form, setForm] = useState<LocalForm>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [backups, setBackups] = useState<BackupMeta[]>([])

  const load = useCallback(async (): Promise<void> => {
    const [s, backupList] = await Promise.all([
      window.api.settings.get(),
      window.api.playRecords.listBackups().catch(() => [] as BackupMeta[])
    ])
    setBackups(backupList.slice(0, 5))
    setForm({
      lockLevel: s.lockLevel,
      endAction: s.endAction,
      sessionMaxHours: s.sessionMaxHours,
      // 旧配置缺失该字段时按默认值 true 处理（SETTINGS_DEFAULTS.sessionOverlay = true）
      sessionOverlay: s.sessionOverlay !== false,
      focusMin: s.pomodoro.focusMin,
      shortBreakMin: s.pomodoro.shortBreakMin,
      longBreakMin: s.pomodoro.longBreakMin,
      longBreakEvery: s.pomodoro.longBreakEvery,
      strictness: s.bili.strictness,
      autoFullscreen: s.bili.autoFullscreen,
      baseURL: s.ai.baseURL,
      apiKey: s.ai.apiKey,
      model: s.ai.model,
      ocrModel: s.ai.ocrModel,
      maxQuestionsPerSession: s.ai.maxQuestionsPerSession,
      noisePreset: s.noisePreset,
      hasCode: !!s.recoveryCodeHash,
      telemetryEnabled: !!s.telemetryEnabled,
      backupEnabled: s.backup?.enabled ?? true,
      backupFrequency: s.backup?.frequency ?? 'daily',
      backupTime: s.backup?.time ?? '03:00',
      backupKeepCount: s.backup?.keepCount ?? 7,
      backupDirectory: s.backup?.directory ?? ''
    })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refreshBackups = useCallback(async (): Promise<void> => {
    const backupList = await window.api.playRecords.listBackups().catch(() => [] as BackupMeta[])
    setBackups(backupList.slice(0, 5))
  }, [])

  /** 即时生效：写入 electron-store */
  const update = useCallback<UpdateFn>(
    async (entries, tip) => {
      setSaving(true)
      try {
        await window.api.settings.set(entries)
        if (tip) message.success(tip)
        await load()
      } catch (err) {
        message.error(err instanceof Error ? err.message : '保存失败')
      } finally {
        setSaving(false)
      }
    },
    [load]
  )

  return { form, setForm, saving, backups, load, refreshBackups, update }
}
