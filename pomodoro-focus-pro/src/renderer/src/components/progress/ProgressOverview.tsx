import { useEffect, useState } from 'react'
import { Button, InputNumber, Modal, Progress, Tag, Tooltip, message } from 'antd'
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  EditOutlined,
  FireOutlined,
  PlayCircleOutlined,
  RocketOutlined,
  TrophyOutlined
} from '@ant-design/icons'
import { useProgressStore } from '../../store/progressStore'
import { resumeVideo } from '../../utils/resumeVideo'
import { formatSeconds } from '../../overlay/ProgressRing'
import { recordPercent, roundCount, timeAgo, deadlineInfo, STATUS_META } from './format'

interface ProgressOverviewProps {
  /** 当前视频 bvid（决定"当前视频"高亮与快捷操作） */
  bvid?: string
  /** 当前视频时间点跳转 */
  onSeek(seconds: number): void
}

/**
 * 概览区（M2 快速续学 + M3 统计与全局目标）：
 * - 4 张统计卡：今日 / 本周 / 连续 / 已完成
 * - 全局目标行：今日 x/y 分钟 · 本周 a/b 天（可编辑，存 settings.studyGoals）
 * - 继续学习卡片：最近学习的一门课程，一键续学；当前视频时提供 回到位置 / 标记学完 快捷操作
 */
function ProgressOverview({ bvid, onSeek }: ProgressOverviewProps): JSX.Element {
  const stats = useProgressStore((s) => s.stats)
  const all = useProgressStore((s) => s.all)
  const refreshStats = useProgressStore((s) => s.refreshStats)
  const markDone = useProgressStore((s) => s.markDone)

  const [goalOpen, setGoalOpen] = useState(false)
  const [dailyMinutes, setDailyMinutes] = useState(60)
  const [weeklyDays, setWeeklyDays] = useState(5)

  const recent = all[0] ?? null
  const isCurrent = recent != null && recent.bvid === bvid

  const openGoalEditor = (): void => {
    void window.api.settings
      .get()
      .then((s) => {
        setDailyMinutes(s.studyGoals?.dailyMinutes ?? 0)
        setWeeklyDays(s.studyGoals?.weeklyDays ?? 0)
        setGoalOpen(true)
      })
      .catch(() => setGoalOpen(true))
  }

  const saveGoals = async (): Promise<void> => {
    try {
      await window.api.settings.set({
        'studyGoals.dailyMinutes': Math.max(0, Math.round(dailyMinutes || 0)),
        'studyGoals.weeklyDays': Math.max(0, Math.round(weeklyDays || 0))
      })
      setGoalOpen(false)
      void refreshStats()
      message.success('学习目标已保存')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '目标保存失败')
    }
  }

  const handleContinue = (): void => {
    if (!recent) return
    if (recent.bvid === bvid) {
      // 当前视频：直接跳转上次位置（含 0 → 从头播放），不重新打开窗口
      onSeek(recent.lastPositionS)
    } else {
      void resumeVideo(recent).catch((err) =>
        message.error(`续学失败: ${err instanceof Error ? err.message : String(err)}`)
      )
    }
  }

  const goal = deadlineInfo(recent?.goalDeadline ?? '')
  const todayGoal = stats?.dailyGoalMinutes ?? 0
  const weekGoal = stats?.weeklyGoalDays ?? 0

  return (
    <div className="progress-overview">
      {/* 统计卡（M3） */}
      <div className="progress-stat-grid">
        <div className="progress-stat-card">
          <div className="progress-stat-icon">
            <ClockCircleOutlined />
          </div>
          <div className="progress-stat-value">{stats ? `${stats.todayMinutes}` : '—'}</div>
          <div className="progress-stat-label">今日学习（分钟）</div>
        </div>
        <div className="progress-stat-card">
          <div className="progress-stat-icon">
            <RocketOutlined />
          </div>
          <div className="progress-stat-value">{stats ? `${stats.weekMinutes}` : '—'}</div>
          <div className="progress-stat-label">本周学习（分钟）</div>
        </div>
        <div className="progress-stat-card">
          <div className="progress-stat-icon">
            <FireOutlined />
          </div>
          <div className="progress-stat-value">{stats ? `${stats.streakDays}` : '—'}</div>
          <div className="progress-stat-label">连续学习（天）</div>
        </div>
        <div className="progress-stat-card">
          <div className="progress-stat-icon">
            <TrophyOutlined />
          </div>
          <div className="progress-stat-value">
            {stats ? `${stats.doneCourses}/${stats.totalCourses}` : '—'}
          </div>
          <div className="progress-stat-label">已完成课程</div>
        </div>
      </div>

      {/* 全局目标（M3）：恒显示目标行，保证目标设置入口始终可达 */}
      <div className="progress-goal-row">
        {todayGoal > 0 && weekGoal > 0 ? (
          <>
            <span className="progress-goal-item">
              🎯 今日 {stats?.todayMinutes ?? 0}/{todayGoal} 分钟
            </span>
            <span className="progress-goal-item">
              📅 本周 {stats?.weekDaysStudied ?? 0}/{weekGoal} 天
            </span>
          </>
        ) : (
          <span className="progress-goal-item">未设定每日 / 每周学习目标</span>
        )}
        <Button
          size="small"
          type="text"
          icon={<EditOutlined />}
          onClick={openGoalEditor}
          className="progress-goal-edit"
        >
          目标设置
        </Button>
      </div>

      {/* 继续学习卡片（M2 快速续学） */}
      {recent && (
        <div className={`progress-continue${isCurrent ? ' current' : ''}`}>
          <div className="progress-continue-cover">
            {recent.coverUrl ? (
              <img src={recent.coverUrl} alt="" loading="lazy" />
            ) : (
              <PlayCircleOutlined />
            )}
          </div>
          <div className="progress-continue-main">
            <div className="progress-continue-title" title={recent.title || recent.bvid}>
              {recent.title || recent.bvid}
            </div>
            <div className="progress-continue-meta">
              {recent.author ? `${recent.author} · ` : ''}
              {recent.durationS > 0 ? formatSeconds(recent.durationS) : '未知时长'} · 已学{' '}
              {formatSeconds(recent.watchedS)}
              {roundCount(recent) > 0 ? ` · 精读 ${roundCount(recent)} 遍` : ''}
              <Tag color={STATUS_META[recent.status].color} style={{ marginLeft: 4 }}>
                {STATUS_META[recent.status].label}
              </Tag>
            </div>
            <Progress
              percent={recordPercent(recent)}
              size="small"
              strokeColor="var(--brand, #ff6b4a)"
              trailColor="var(--bg-hover, #232a36)"
            />
            <div className="progress-continue-foot">
              <span className="progress-continue-time">
                上次学习：{timeAgo(recent.updatedAt) || '—'}
                {goal ? (
                  <span
                    className={goal.overdue ? 'progress-deadline-overdue' : 'progress-deadline'}
                  >
                    {' '}
                    · {goal.text}
                  </span>
                ) : null}
              </span>
              <span className="progress-continue-actions">
                {isCurrent && recent.lastPositionS > 0 && (
                  <Tooltip title="跳转到上次离开位置">
                    <Button size="small" onClick={() => onSeek(recent.lastPositionS)}>
                      ⏱ 回到 {formatSeconds(recent.lastPositionS)}
                    </Button>
                  </Tooltip>
                )}
                {isCurrent && recent.status !== 'done' && (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    icon={<CheckCircleOutlined />}
                    onClick={() => {
                      void markDone(recent.bvid).then(() => message.success('已标记为学完'))
                    }}
                  >
                    标记学完
                  </Button>
                )}
                <Button
                  size="small"
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={handleContinue}
                >
                  {isCurrent ? '继续观看' : '继续学习'}
                </Button>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 全局目标编辑 */}
      <Modal
        title="学习目标设置"
        open={goalOpen}
        onOk={() => void saveGoals()}
        onCancel={() => setGoalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={360}
        centered
      >
        <div className="progress-goal-form">
          <div className="progress-goal-field">
            <span>每日学习时长（分钟）</span>
            <InputNumber
              min={0}
              max={1440}
              value={dailyMinutes}
              onChange={(v) => setDailyMinutes(v ?? 0)}
            />
          </div>
          <div className="progress-goal-field">
            <span>每周学习天数</span>
            <InputNumber
              min={0}
              max={7}
              value={weeklyDays}
              onChange={(v) => setWeeklyDays(v ?? 0)}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default ProgressOverview
