import { useState } from 'react'
import { Button, Card, Divider, Switch, Typography } from 'antd'
import { MessageOutlined } from '@ant-design/icons'
import FeedbackDialog from '../../components/FeedbackDialog'
import { useSetting } from './useSetting'
import type { LocalForm, UpdateFn } from './types'

interface HelpImproveCardProps {
  form: LocalForm
  saving: boolean
  update: UpdateFn
}

/** 📈 帮助改进（R-2，可选匿名统计） */
export default function HelpImproveCard({
  form,
  saving,
  update
}: HelpImproveCardProps): JSX.Element {
  /** 问题 3：反馈模块从 视频学习页迁移至设置页（R-1，复用 FeedbackDialog） */
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [telemetryEnabled, setTelemetryEnabled] = useSetting<boolean>(
    form,
    update,
    'telemetryEnabled',
    'telemetryEnabled',
    (v) => (v ? '已开启匿名统计' : '已关闭匿名统计')
  )

  return (
    <Card size="small" title="📈 帮助改进（R-2，可选匿名统计）" className="settings-card">
      <div className="settings-row">
        <span className="settings-label">开启匿名使用统计</span>
        <Switch
          checked={telemetryEnabled}
          disabled={saving}
          onChange={(v) => setTelemetryEnabled(v)}
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        默认关闭。开启后仅本地记录计数与时长（打开视频数、会话时长、提问数、导航拦截次数、面板显隐次数），
        绝不上送视频号、关键词、笔记内容或任何输入文本；可随时一键关闭。
      </Typography.Text>
      {/* 问题 3：反馈入口由 视频学习页迁移至此（复用 FeedbackDialog，IPC 通道不变） */}
      <Divider style={{ margin: '10px 0' }} />
      <div className="settings-row">
        <span className="settings-label">应用反馈</span>
        <Button size="small" icon={<MessageOutlined />} onClick={() => setFeedbackOpen(true)}>
          提交反馈
        </Button>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        满意度打分 + 问题分类 + 一句话描述，仅保存在本地（feedback 表），不会上传。
      </Typography.Text>

      {/* 问题 3：反馈弹窗（从 视频学习页迁移；mode=general 全局反馈） */}
      <FeedbackDialog open={feedbackOpen} mode="general" onClose={() => setFeedbackOpen(false)} />
    </Card>
  )
}
