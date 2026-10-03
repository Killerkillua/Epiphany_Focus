import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Empty, Segmented, Spin, Typography } from 'antd'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { FeedbackStats, HeatmapCell, PlayRecord } from '../../../shared/stats'
import type { NoteEntry } from '../../../shared/bili'
import { modeColor, modeLabel } from '../../../shared/constants'
import { useStatsStore } from '../store/statsStore'

/**
 * 学习统计（方案 2.3/3.4，重构后）：
 * - 数据来自 statsStore（统一缓存 + 完成事件实时刷新），不再页面内重复拉取
 * - 趋势 / 模式对比使用 recharts（tooltip 交互），热力图保留 CSS grid + Map O(1) 查找
 * - 数据库不可用（SQLite 加载失败）时展示显式错误态与重试
 */

type TrendRange = 7 | 14 | 30

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const TREND_COLOR = '#ff6b4a'
const AXIS_TICK = { fontSize: 11, fill: '#8b93a7' }
const GRID_STROKE = 'rgba(255,255,255,0.06)'

interface TrendTooltipProps {
  active?: boolean
  payload?: Array<{ payload: { date: string; minutes: number; pomos: number } }>
}

function TrendTooltip({ active, payload }: TrendTooltipProps): JSX.Element | null {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{p.date}</div>
      <div>
        专注 <span className="chart-tooltip-value">{p.minutes} 分钟</span> · {p.pomos} 番茄
      </div>
    </div>
  )
}

interface ModeTooltipProps {
  active?: boolean
  payload?: Array<{ payload: { name: string; minutes: number; pomos: number } }>
}

function ModeTooltip({ active, payload }: ModeTooltipProps): JSX.Element | null {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{p.name}</div>
      <div>
        累计 <span className="chart-tooltip-value">{Math.round(p.minutes)} 分钟</span> · {p.pomos}{' '}
        番茄
      </div>
    </div>
  )
}

function StatsPage(): JSX.Element {
  const [range, setRange] = useState<TrendRange>(14)
  const [hover, setHover] = useState<{ label: string; minutes: number; sessions: number } | null>(
    null
  )

  const trend = useStatsStore((s) => s.trend)
  const modes = useStatsStore((s) => s.modes)
  const heatmap = useStatsStore((s) => s.heatmap)
  const loading = useStatsStore((s) => s.loading)
  const error = useStatsStore((s) => s.error)

  /* ===== R-4 视频学习复盘卡（play_records + notes + feedback 聚合） ===== */
  const [biliReview, setBiliReview] = useState<{
    records: PlayRecord[]
    feedback: FeedbackStats
    notes: NoteEntry[]
  } | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([
      window.api.playRecords.list(),
      window.api.feedback.stats(),
      window.api.notes.load()
    ])
      .then(([records, feedback, notes]) => {
        if (alive) setBiliReview({ records, feedback, notes })
      })
      .catch(() => {
        /* 数据不可用时不阻塞统计页 */
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    useStatsStore.getState().setPageActive(true)
    void useStatsStore.getState().loadAll(range)
    return () => useStatsStore.getState().setPageActive(false)
  }, [range])

  // 热力图 7×24 查找：Map<"weekday-hour", cell> O(1)（原 Array.find 为 O(168×n)）
  const cells = heatmap ?? []
  const heatMap = useMemo(() => {
    const m = new Map<string, HeatmapCell>()
    for (const c of cells) m.set(`${c.weekday}-${c.hour}`, c)
    return m
  }, [cells])
  const heatMax = Math.max(1, ...cells.map((c) => c.minutes))

  const trendData = trend.map((t) => ({
    name: t.date.slice(5),
    date: t.date,
    minutes: t.minutes,
    pomos: t.pomos
  }))
  const modeData = (modes ?? []).map((m) => ({
    name: modeLabel(m.mode),
    mode: m.mode,
    minutes: m.minutes,
    pomos: m.pomos
  }))

  const retry = (): void => {
    void useStatsStore.getState().loadAll(range)
  }

  /* ===== R-4 复盘派生数据 ===== */
  const review = useMemo(() => {
    if (!biliReview) return null
    const records = biliReview.records
    const watchedMinutes = records.reduce((sum, r) => sum + r.watchedS, 0) / 60
    const doneCount = records.filter((r) => r.status === 'done').length
    const learningCount = records.filter((r) => r.status === 'learning').length
    const keyCount = biliReview.notes.filter((n) => n.isKey).length
    return {
      watchedMinutes,
      doneCount,
      learningCount,
      noteCount: biliReview.notes.length,
      keyCount,
      feedbackCount: biliReview.feedback.count,
      avgRating: biliReview.feedback.avgRating
    }
  }, [biliReview])

  return (
    <div className="page-dashboard">
      <h1 className="page-title">学习统计</h1>
      <p className="page-sub">
        专注时长趋势 · 时段热力图 · 模式对比（数据源 study_stats / sessions）
      </p>

      {error && (
        <Alert
          type="error"
          showIcon
          message="统计功能暂不可用"
          description={error}
          style={{ marginBottom: 14 }}
          action={
            <Button size="small" onClick={retry}>
              重试
            </Button>
          }
        />
      )}

      <Spin spinning={loading}>
        <div className="stats-layout">
          <Card
            size="small"
            title="📈 专注时长趋势"
            className="stats-card"
            extra={
              <Segmented
                size="small"
                value={range}
                options={[
                  { value: 7, label: '近 7 天' },
                  { value: 14, label: '近 14 天' },
                  { value: 30, label: '近 30 天' }
                ]}
                onChange={(v) => setRange(v as TrendRange)}
              />
            }
          >
            {trendData.length === 0 ? (
              <Empty description="暂无专注记录：完成一次专注会话后这里会出现趋势" />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={trendData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
                  <XAxis dataKey="name" tick={AXIS_TICK} interval="preserveStartEnd" />
                  <YAxis tick={AXIS_TICK} />
                  <Tooltip content={<TrendTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                  <Bar
                    dataKey="minutes"
                    name="专注分钟"
                    fill={TREND_COLOR}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>

          <Card size="small" title="🎯 模式对比" className="stats-card">
            {modeData.length === 0 ? (
              <Empty description="暂无数据" />
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(140, modeData.length * 52)}>
                <BarChart
                  data={modeData}
                  layout="vertical"
                  margin={{ top: 4, right: 24, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} horizontal={false} />
                  <XAxis type="number" tick={AXIS_TICK} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={76}
                    tick={{ fontSize: 12, fill: '#e8ebf2' }}
                  />
                  <Tooltip content={<ModeTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                  <Bar dataKey="minutes" name="累计分钟" radius={[0, 6, 6, 0]} barSize={22}>
                    {modeData.map((entry) => (
                      <Cell key={entry.mode} fill={modeColor(entry.mode)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>

          <Card size="small" title="🌡 时段热力图（星期 × 小时）" className="stats-card">
            {cells.length === 0 ? (
              <Empty description="暂无数据（需要已完成的 sessions 记录）" />
            ) : (
              <>
                <div className="heatmap">
                  <div className="heatmap-corner" />
                  {Array.from({ length: 24 }, (_, h) => (
                    <div className="heatmap-hour" key={h}>
                      {h}
                    </div>
                  ))}
                  {WEEKDAYS.map((wd, wi) => (
                    <div className="heatmap-row" key={wd}>
                      <div className="heatmap-wd">周{wd}</div>
                      {Array.from({ length: 24 }, (_, h) => {
                        const cell = heatMap.get(`${wi}-${h}`)
                        const alpha = cell
                          ? Math.min(0.9, 0.12 + (cell.minutes / heatMax) * 0.78)
                          : 0
                        return (
                          <div
                            className="heatmap-cell"
                            key={h}
                            title={
                              cell
                                ? `周${wd} ${h}:00 · ${cell.minutes} 分钟 · ${cell.sessions} 次`
                                : `周${wd} ${h}:00`
                            }
                            onMouseEnter={() =>
                              setHover(
                                cell
                                  ? {
                                      label: `周${wd} ${h}:00`,
                                      minutes: cell.minutes,
                                      sessions: cell.sessions
                                    }
                                  : null
                              )
                            }
                            onMouseLeave={() => setHover(null)}
                            style={{
                              background: cell
                                ? `rgba(255, 107, 74, ${alpha})`
                                : 'rgba(42, 49, 60, 0.35)'
                            }}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
                <div className="heatmap-tip">
                  {hover ? (
                    <>
                      {hover.label} ·{' '}
                      <span className="chart-tooltip-value">{hover.minutes} 分钟</span> ·{' '}
                      {hover.sessions} 次
                    </>
                  ) : (
                    '悬停色块查看该时段详情'
                  )}
                </div>
              </>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              颜色越深 = 该时段专注分钟越多。
            </Typography.Text>
          </Card>

          <Card size="small" title="📺 视频学习复盘（R-4）" className="stats-card">
            {review ? (
              <div className="bili-review-grid">
                <div className="bili-review-item">
                  <div className="bili-review-value">
                    {review.watchedMinutes >= 60
                      ? `${(review.watchedMinutes / 60).toFixed(1)}h`
                      : `${Math.round(review.watchedMinutes)}min`}
                  </div>
                  <div className="bili-review-label">累计观看</div>
                </div>
                <div className="bili-review-item">
                  <div className="bili-review-value">{review.doneCount}</div>
                  <div className="bili-review-label">已学完视频</div>
                </div>
                <div className="bili-review-item">
                  <div className="bili-review-value">{review.learningCount}</div>
                  <div className="bili-review-label">学习中</div>
                </div>
                <div className="bili-review-item">
                  <div className="bili-review-value">
                    {review.noteCount}
                    {review.keyCount > 0 && (
                      <span className="bili-review-key">★{review.keyCount}</span>
                    )}
                  </div>
                  <div className="bili-review-label">笔记（重点）</div>
                </div>
                <div className="bili-review-item">
                  <div className="bili-review-value">
                    {review.feedbackCount > 0 ? `★${review.avgRating.toFixed(1)}` : '—'}
                  </div>
                  <div className="bili-review-label">满意度自评</div>
                </div>
              </div>
            ) : (
              <Empty description="暂无视频学习数据：打开视频学习后这里会生成复盘" />
            )}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              数据源 play_records（按视频进度）+ notes（笔记/重点）+
              feedback（本地自评），驱动每周迭代。
            </Typography.Text>
          </Card>
        </div>
      </Spin>
    </div>
  )
}

export default StatsPage
