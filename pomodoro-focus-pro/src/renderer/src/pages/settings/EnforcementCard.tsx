import { useState } from 'react'
import { Button, Card, Divider, Radio, Select, Space, Typography } from 'antd'
import type { EndAction, LockLevel } from '../../../../shared/settings'
import { LEVEL_LABEL } from '../../../../main/enforcement/level'
import { useSetting } from './useSetting'
import NumberSettingRow from './NumberSettingRow'
import RecoveryCodeModal from './RecoveryCodeModal'
import type { LocalForm, UpdateFn } from './types'

interface EnforcementCardProps {
  form: LocalForm
  saving: boolean
  update: UpdateFn
  /** 恢复码保存成功后刷新设置快照（hasCode 变化） */
  onCodeSaved: () => Promise<void>
}

/** 🔒 强制控制（方案 2.5） */
export default function EnforcementCard({
  form,
  saving,
  update,
  onCodeSaved
}: EnforcementCardProps): JSX.Element {
  const [codeOpen, setCodeOpen] = useState(false)
  const [lockLevel, setLockLevel] = useSetting<LockLevel>(
    form,
    update,
    'lockLevel',
    'lockLevel',
    '锁定级别已更新'
  )
  const [endAction, setEndAction] = useSetting<EndAction>(
    form,
    update,
    'endAction',
    'endAction',
    '到点动作已更新'
  )

  return (
    <Card size="small" title="🔒 强制控制（方案 2.5）" className="settings-card">
      <div className="settings-row">
        <span className="settings-label">锁定级别</span>
        <Radio.Group
          value={lockLevel}
          disabled={saving}
          onChange={(e) => setLockLevel(e.target.value as LockLevel)}
        >
          <Radio value="L0">L0 轻量</Radio>
          <Radio value="L1">L1 标准</Radio>
          <Radio value="L2">L2 强化</Radio>
        </Radio.Group>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {LEVEL_LABEL[form.lockLevel]}
      </Typography.Text>
      <Divider style={{ margin: '10px 0' }} />
      <div className="settings-row">
        <span className="settings-label">到点动作</span>
        <Select
          style={{ width: 180 }}
          value={endAction}
          disabled={saving}
          options={[
            { value: 'lock', label: '锁屏' },
            { value: 'overlay', label: '全屏遮罩（保持）' },
            { value: 'notify', label: '仅提示' }
          ]}
          onChange={(v) => setEndAction(v as EndAction)}
        />
      </div>
      <NumberSettingRow
        label="会话上限（小时）"
        dottedKey="sessionMaxHours"
        value={form.sessionMaxHours}
        min={1}
        max={24}
        saving={saving}
        update={update}
      />
      <Divider style={{ margin: '10px 0' }} />
      <div className="settings-row">
        <span className="settings-label">紧急恢复码</span>
        <Space>
          <Typography.Text type={form.hasCode ? 'success' : 'warning'}>
            {form.hasCode ? '已设置（bcrypt 哈希）' : '未设置'}
          </Typography.Text>
          <Button size="small" onClick={() => setCodeOpen(true)}>
            {form.hasCode ? '修改' : '设置'}
          </Button>
        </Space>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        L1/L2 强制会话开始前必须已设置恢复码；连按 5 次 Esc 触发紧急退出。
      </Typography.Text>

      <RecoveryCodeModal
        open={codeOpen}
        hasCode={form.hasCode}
        onClose={() => setCodeOpen(false)}
        onSaved={onCodeSaved}
      />
    </Card>
  )
}
