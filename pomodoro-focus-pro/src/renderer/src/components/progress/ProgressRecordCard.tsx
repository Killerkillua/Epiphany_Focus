import { Button, Checkbox, Dropdown, Progress, Tag } from 'antd'
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  MoreOutlined,
  PlayCircleOutlined
} from '@ant-design/icons'
import type { PlayRecord } from '../../../../shared/stats'
import { formatSeconds } from '../../overlay/ProgressRing'
import { recordPercent, roundCount, timeAgo, deadlineInfo, STATUS_META } from './format'

interface ProgressRecordCardProps {
  rec: PlayRecord
  /** 是否为当前视频（高亮 + 续学降级为 seek） */
  isCurrent: boolean
  selectMode: boolean
  selected: boolean
  onToggleSelect(bvid: string): void
  /** 续学：当前视频 → seek；其他 → 打开视频 */
  onContinue(rec: PlayRecord): void
  onEdit(rec: PlayRecord): void
  onDelete(rec: PlayRecord): void
  onMarkDone(bvid: string): void
}

/**
 * 单条学习记录卡片（M1 管理 / M2 快捷访问）：
 * 点击主体 → 续学（当前视频则 seek 到上次位置）；选择模式下点击 → 勾选。
 * 「⋯」菜单：调整进度 / 标记已学完（未完成时）/ 删除。
 */
function ProgressRecordCard({
  rec,
  isCurrent,
  selectMode,
  selected,
  onToggleSelect,
  onContinue,
  onEdit,
  onDelete,
  onMarkDone
}: ProgressRecordCardProps): JSX.Element {
  const goal = deadlineInfo(rec.goalDeadline)
  const pct = recordPercent(rec)
  const rounds = roundCount(rec)

  const handleBodyClick = (): void => {
    if (selectMode) onToggleSelect(rec.bvid)
    else onContinue(rec)
  }

  const menuItems = [
    { key: 'edit', icon: <EditOutlined />, label: '调整进度', onClick: () => onEdit(rec) },
    ...(rec.status !== 'done'
      ? [
          {
            key: 'done',
            icon: <CheckCircleOutlined />,
            label: '标记已学完',
            onClick: () => onMarkDone(rec.bvid)
          }
        ]
      : []),
    { type: 'divider' as const },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: '删除',
      danger: true,
      onClick: () => onDelete(rec)
    }
  ]

  return (
    <div
      className={`progress-card${isCurrent ? ' current' : ''}${selectMode ? ' select-mode' : ''}${selected ? ' selected' : ''}`}
      onClick={handleBodyClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleBodyClick()
        }
      }}
    >
      {selectMode && (
        <div className="progress-card-check" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected} onChange={() => onToggleSelect(rec.bvid)} />
        </div>
      )}
      <div className="progress-card-cover">
        {rec.coverUrl ? <img src={rec.coverUrl} alt="" loading="lazy" /> : <PlayCircleOutlined />}
      </div>
      <div className="progress-card-main">
        <div className="progress-card-title" title={rec.title || rec.bvid}>
          {rec.resourceType === 'local' && <Tag>本地</Tag>}
          {rec.resourceType === 'web' && <Tag>网站</Tag>}
          {rec.title || rec.bvid}
        </div>
        <div className="progress-card-meta">
          {rec.author ? `${rec.author} · ` : ''}
          {rec.durationS > 0 ? formatSeconds(rec.durationS) : '未知时长'} · 上次学习{' '}
          {timeAgo(rec.updatedAt) || '—'}
        </div>
        <Progress
          percent={pct}
          size="small"
          strokeColor="var(--brand, #ff6b4a)"
          trailColor="var(--bg-hover, #232a36)"
        />
        <div className="progress-card-foot">
          <span className="progress-card-stats">
            {pct}% · 已学 {formatSeconds(rec.watchedS)}
            {rounds > 0 ? ` · 精读 ${rounds} 遍` : ''}
            {rec.viewedCount > 0 ? ` · 看过 ${rec.viewedCount} 次` : ''}
          </span>
          <span className="progress-card-tags">
            {rec.tags.map((t) => (
              <Tag key={t} className="progress-tag" closable={false}>
                {t}
              </Tag>
            ))}
            {goal && (
              <span className={goal.overdue ? 'progress-deadline-overdue' : 'progress-deadline'}>
                {goal.text}
              </span>
            )}
            <Tag color={STATUS_META[rec.status].color} className="progress-status-tag">
              {STATUS_META[rec.status].label}
            </Tag>
          </span>
        </div>
      </div>
      {!selectMode && (
        <div className="progress-card-actions" onClick={(e) => e.stopPropagation()}>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<PlayCircleOutlined />}
            onClick={() => onContinue(rec)}
          >
            续学
          </Button>
          <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
            <Button size="small" type="text" icon={<MoreOutlined />} aria-label="更多操作" />
          </Dropdown>
        </div>
      )}
    </div>
  )
}

export default ProgressRecordCard
