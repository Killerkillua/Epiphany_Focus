import { Card, Col, Row } from 'antd'
import NumberSettingRow from './NumberSettingRow'
import type { LocalForm, UpdateFn } from './types'

interface PomodoroCardProps {
  form: LocalForm
  saving: boolean
  update: UpdateFn
}

/** 🍅 番茄钟参数 */
export default function PomodoroCard({ form, saving, update }: PomodoroCardProps): JSX.Element {
  return (
    <Card size="small" title="🍅 番茄钟参数" className="settings-card">
      <Row gutter={[32, 4]}>
        <Col xs={24} sm={12}>
          <NumberSettingRow
            label="专注时长 (分钟)"
            dottedKey="pomodoro.focusMin"
            value={form.focusMin}
            saving={saving}
            update={update}
          />
        </Col>
        <Col xs={24} sm={12}>
          <NumberSettingRow
            label="长休息间隔 (个)"
            dottedKey="pomodoro.longBreakEvery"
            value={form.longBreakEvery}
            min={2}
            max={20}
            saving={saving}
            update={update}
          />
        </Col>
        <Col xs={24} sm={12}>
          <NumberSettingRow
            label="短休息 (分钟)"
            dottedKey="pomodoro.shortBreakMin"
            value={form.shortBreakMin}
            min={1}
            max={30}
            saving={saving}
            update={update}
          />
        </Col>
        <Col xs={24} sm={12}>
          <NumberSettingRow
            label="长休息 (分钟)"
            dottedKey="pomodoro.longBreakMin"
            value={form.longBreakMin}
            min={5}
            max={60}
            saving={saving}
            update={update}
          />
        </Col>
      </Row>
    </Card>
  )
}
