import { InputNumber } from 'antd'
import type { UpdateFn } from './types'

interface NumberSettingRowProps {
  label: string
  dottedKey: string
  value: number
  min?: number
  max?: number
  saving: boolean
  update: UpdateFn
}

/** 数字设置行：标签 + InputNumber，改动即保存（复用自原 SettingsPage.numberRow） */
export default function NumberSettingRow({
  label,
  dottedKey,
  value,
  min = 1,
  max = 120,
  saving,
  update
}: NumberSettingRowProps): JSX.Element {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <InputNumber
        min={min}
        max={max}
        value={value}
        disabled={saving}
        onChange={(v) => void update({ [dottedKey]: Number(v ?? min) })}
      />
    </div>
  )
}
