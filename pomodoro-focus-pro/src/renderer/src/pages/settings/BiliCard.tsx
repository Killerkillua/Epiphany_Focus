import { Card, Select, Switch } from 'antd'
import type { BiliStrictness } from '../../../../shared/settings'
import { useSetting } from './useSetting'
import type { LocalForm, UpdateFn } from './types'

interface BiliCardProps {
  form: LocalForm
  saving: boolean
  update: UpdateFn
}

/** 📺 视频学习模式 */
export default function BiliCard({ form, saving, update }: BiliCardProps): JSX.Element {
  const [strictness, setStrictness] = useSetting<BiliStrictness>(
    form,
    update,
    'strictness',
    'bili.strictness',
    '相关度档位已更新'
  )
  const [autoFullscreen, setAutoFullscreen] = useSetting<boolean>(
    form,
    update,
    'autoFullscreen',
    'bili.autoFullscreen',
    '自动全屏已更新'
  )

  return (
    <Card size="small" title="📺 视频学习模式" className="settings-card">
      <div className="settings-row">
        <span className="settings-label">内容相关度档位</span>
        <Select
          style={{ width: 160 }}
          value={strictness}
          disabled={saving}
          options={[
            { value: 'strict', label: '严格' },
            { value: 'standard', label: '标准' },
            { value: 'loose', label: '宽松' }
          ]}
          onChange={(v) => setStrictness(v as BiliStrictness)}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">点击视频自动全屏</span>
        <Switch checked={autoFullscreen} disabled={saving} onChange={setAutoFullscreen} />
      </div>
    </Card>
  )
}
