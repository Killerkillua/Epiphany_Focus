import { useState } from 'react'
import { Button, InputNumber, Modal } from 'antd'

export type ModeTarget = 'focus' | 'bili' | 'english'

interface Props {
  open: boolean
  mode: ModeTarget | null
  defaultMin: number
  onCancel: () => void
  onConfirm: (minutes: number) => void
}

const FOCUS_PRESETS = [25, 45, 60, 90]
const SESSION_PRESETS = [60, 120, 240]

const LABELS: Record<ModeTarget, string> = {
  focus: '专注模式',
  bili: 'B 站学习',
  english: '英语学习'
}

function DurationConfigModal({ open, mode, defaultMin, onCancel, onConfirm }: Props): JSX.Element {
  const [custom, setCustom] = useState<number>(defaultMin)

  if (!mode) return <></>

  const isFocus = mode === 'focus'
  const presets = isFocus ? FOCUS_PRESETS : SESSION_PRESETS
  const label = LABELS[mode]
  const unit = isFocus ? '分钟（番茄时长）' : '分钟（会话上限）'

  const handleConfirm = (): void => {
    const v = Math.max(1, Math.min(480, custom))
    onConfirm(v)
  }

  return (
    <Modal
      title={`${label} · 配置时长`}
      open={open}
      onOk={handleConfirm}
      onCancel={onCancel}
      okText="开始"
      cancelText="取消"
      destroyOnClose
      // 全屏（B 站/专注强制会话）下按视口比例流体缩放，窗口模式下保持常规宽度
      rootClassName="app-fluid-modal"
    >
      <div style={{ marginBottom: 12 }}>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{unit}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {presets.map((m) => (
          <Button
            key={m}
            type={custom === m ? 'primary' : 'default'}
            onClick={() => setCustom(m)}
          >
            {m} 分钟
          </Button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>自定义：</span>
        <InputNumber
          min={1}
          max={480}
          value={custom}
          onChange={(v) => v !== null && setCustom(v)}
          style={{ width: 100 }}
        />
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>分钟</span>
      </div>
    </Modal>
  )
}

export default DurationConfigModal