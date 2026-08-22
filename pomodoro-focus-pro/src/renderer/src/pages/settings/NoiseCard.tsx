import { Card, Select, Typography } from 'antd'
import { useSetting } from './useSetting'
import { NOISE_OPTIONS, type LocalForm, type UpdateFn } from './types'

interface NoiseCardProps {
  form: LocalForm
  saving: boolean
  update: UpdateFn
}

/** 🎧 白噪音 */
export default function NoiseCard({ form, saving, update }: NoiseCardProps): JSX.Element {
  const [noisePreset, setNoisePreset] = useSetting<string>(
    form,
    update,
    'noisePreset',
    'noisePreset',
    '白噪音预设已更新'
  )

  return (
    <Card size="small" title="🎧 白噪音" className="settings-card">
      <div className="settings-row">
        <span className="settings-label">默认预设</span>
        <Select
          style={{ width: 160 }}
          value={noisePreset}
          disabled={saving}
          options={NOISE_OPTIONS}
          onChange={(v) => setNoisePreset(v)}
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        合成层（白/粉/棕噪）即时可用；采样层需打包 resources/audio 素材后自动生效。
      </Typography.Text>
    </Card>
  )
}
