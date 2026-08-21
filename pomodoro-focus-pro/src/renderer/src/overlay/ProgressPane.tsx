import { useEffect, useState } from 'react'
import { Button, Input, InputNumber, Progress, Tag, Tooltip, message } from 'antd'
import { CheckCircleOutlined, FlagOutlined, ReloadOutlined } from '@ant-design/icons'
import type { PlayRecord } from '../../../shared/stats'
import { ProgressRing, formatSeconds } from './ProgressRing'

interface ProgressPaneProps {
  /** 当前视频进度记录 */
  current: PlayRecord | null
  /** 全部学习进度 */
  all: PlayRecord[]
  bvid?: string
  onMarkDone(bvid: string): void
  /** 返回 Promise：调用方在落库完成后 resolve，供保存提示等待真实结果 */
  onSetGoal(bvid: string, goalRounds: number, goalDeadline?: string): Promise<void>
  /** 时间点跳转（跳当前视频的指定进度） */
  onSeek(seconds: number): void
  onRefresh(): void
}

const STATUS_META: Record<PlayRecord['status'], { label: string; color: string }> = {
  planned: { label: '计划中', color: 'default' },
  learning: { label: '学习中', color: 'processing' },
  done: { label: '已学完', color: 'success' }
}

function percent(rec: PlayRecord): number {
  if (!rec.durationS || rec.durationS <= 0) return 0
  return Math.min(100, Math.round((rec.watchedS / rec.durationS) * 100))
}

/**
 * 进度页签（I-1 + F-3）：当前视频「已看 x / 总时长 y · 进度 % · 看过 n 遍」，
 * 全部视频按状态分组展示；支持标记学完与学习目标设定（F-5）。
 */
function ProgressPane({ current, all, bvid, onMarkDone, onSetGoal, onSeek, onRefresh }: ProgressPaneProps): JSX.Element {
  const [goalRounds, setGoalRounds] = useState<number>(current?.goalRounds ?? 0)
  const [goalDeadline, setGoalDeadline] = useState<string>(current?.goalDeadline ?? '')

  // 当前视频切换时同步目标表单
  useEffect(() => {
    setGoalRounds(current?.goalRounds ?? 0)
    setGoalDeadline(current?.goalDeadline ?? '')
  }, [current?.bvid, current?.goalRounds, current?.goalDeadline])

  /** 保存目标：等 setGoal 落库完成后再提示，成功/失败提示可靠 */
  const saveGoal = async (): Promise<void> => {
    if (!bvid) return
    try {
      await onSetGoal(bvid, goalRounds || 0, goalDeadline || undefined)
      message.success('学习目标已保存')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '目标保存失败')
    }
  }

  return (
    <div className="overlay-pane overlay-progress-pane">
      {/* 当前视频 */}
      <div className="overlay-progress-current">
        {current ? (
          <>
            <div className="overlay-progress-head">
              <ProgressRing ratio={percent(current) / 100} size={44} stroke={4} label={`当前视频学习进度 ${percent(current)}%`} />
              <div className="overlay-progress-info">
                <div className="overlay-progress-title" title={current.title}>
                  {current.title || current.bvid}
                </div>
                <div className="overlay-progress-meta">
                  已看 {formatSeconds(current.watchedS)} / {current.durationS > 0 ? formatSeconds(current.durationS) : '未知'} · 看过{' '}
                  {current.viewedCount} 遍
                  <Tag color={STATUS_META[current.status].color} style={{ marginLeft: 6 }}>
                    {STATUS_META[current.status].label}
                  </Tag>
                </div>
              </div>
            </div>
            <Progress
              percent={percent(current)}
              size="small"
              strokeColor="var(--brand, #ff6b4a)"
              trailColor="var(--bg-hover, #232a36)"
            />
            {current.lastPositionS > 0 && (
              <Tooltip title="跳转到上次离开位置">
                <Button
                  size="small"
                  className="overlay-progress-seek"
                  onClick={() => onSeek(current.lastPositionS)}
                >
                  ⏱ 回到 {formatSeconds(current.lastPositionS)}
                </Button>
              </Tooltip>
            )}
            {current.status !== 'done' && (
              <Button
                size="small"
                type="primary"
                ghost
                icon={<CheckCircleOutlined />}
                onClick={() => onMarkDone(current.bvid)}
              >
                标记已学完
              </Button>
            )}
            {/* 学习目标（F-5） */}
            <div className="overlay-progress-goal">
              <span className="overlay-progress-goal-label">
                <FlagOutlined /> 目标
              </span>
              <InputNumber
                size="small"
                min={0}
                max={99}
                value={goalRounds}
                onChange={(v) => setGoalRounds(v ?? 0)}
                addonAfter="遍"
                style={{ width: 96 }}
              />
              <Input
                size="small"
                type="date"
                value={goalDeadline}
                onChange={(e) => setGoalDeadline(e.target.value)}
                style={{ width: 132 }}
              />
              <Button size="small" onClick={() => void saveGoal()}>
                保存
              </Button>
            </div>
          </>
        ) : (
          <div className="overlay-progress-empty">暂无当前视频学习进度</div>
        )}
      </div>

      {/* 全部学习进度 */}
      <div className="overlay-progress-list-head">
        <span>全部学习记录</span>
        <Tooltip title="刷新">
          <Button type="text" size="small" icon={<ReloadOutlined />} onClick={onRefresh} />
        </Tooltip>
      </div>
      <div className="overlay-progress-list">
        {all.length === 0 ? (
          <div className="overlay-progress-empty">打开视频开始记录学习进度</div>
        ) : (
          all.map((rec) => (
            <div key={rec.bvid} className={`overlay-progress-row${rec.bvid === bvid ? ' active' : ''}`}>
              <div className="overlay-progress-row-title" title={rec.title}>
                {rec.title || rec.bvid}
              </div>
              <div className="overlay-progress-row-meta">
                {percent(rec)}% · {formatSeconds(rec.watchedS)} · {rec.viewedCount} 遍
                <Tag color={STATUS_META[rec.status].color}>{STATUS_META[rec.status].label}</Tag>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default ProgressPane
