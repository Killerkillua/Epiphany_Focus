import { Card, Switch, Typography } from 'antd'
import { useSetting } from './useSetting'
import type { LocalForm, UpdateFn } from './types'

interface StudySessionCardProps {
  form: LocalForm
  saving: boolean
  update: UpdateFn
}

/** 📚 学习会话 */
export default function StudySessionCard({
  form,
  saving,
  update
}: StudySessionCardProps): JSX.Element {
  const [sessionOverlay, setSessionOverlay] = useSetting<boolean>(
    form,
    update,
    'sessionOverlay',
    'sessionOverlay',
    '学习会话遮罩已更新'
  )

  return (
    <Card size="small" title="📚 学习会话" className="settings-card">
      <div className="settings-row">
        <span className="settings-label">学习会话全屏遮罩</span>
        <Switch checked={sessionOverlay} disabled={saving} onChange={setSessionOverlay} />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        英语 / B
        站学习计时开始后，主窗口进入全屏遮罩（与专注模式一致：全屏、置顶、禁缩放、隐藏任务栏）； B
        站打开视频时由视频窗口的全屏锁定接管。
      </Typography.Text>
    </Card>
  )
}
