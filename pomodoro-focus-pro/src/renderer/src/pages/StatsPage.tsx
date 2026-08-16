import { useEffect, useState } from 'react'
import { Card, Empty, Segmented, Spin, Typography } from 'antd'
import type { DayTrendPoint, HeatmapCell, ModeStat } from '../../../shared/stats'

/**
 * 学习统计（方案 2.3/3.4）：从 study_stats / sessions 聚合。
 * - 日/周/月趋势：近 N 天专注分钟柱状图
 * - 模式对比：各模式累计分钟
 * - 时段热力图：星期 × 小时（sessions 聚合）
 */

type TrendRange = 7 | 14 | 30

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function StatsPage(): JSX.Element {
  const [range, setRange] = useState<TrendRange>(14)
  const [loading, setLoading] = useState(true)
  const [trend, setTrend] = useState<DayTrendPoint[]>([])
  const [modes, setModes] = useState<ModeStat[]>([])
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([])

  const load = async (days: TrendRange): Promise<void> => {
    setLoading(true)
    try {
      const [t, m, h] = await Promise.all([
        window.api.stats.dayTrend(days),
        window.api.stats.modeCompare(),
        window.api.stats.heatmap()
      ])
      setTrend(t)
      setModes(m)
      setHeatmap(h)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(range)
  }, [range])

  const maxMinutes = Math.max(1, ...trend.map((t) => t.minutes))
  const modeMax = Math.max(1, ...modes.map((m) => m.minutes))
  const heatMax = Math.max(1, ...heatmap.map((c) => c.minutes))

  const heatCell = (weekday: number, hour: number): HeatmapCell | undefined =>
    heatmap.find((c) => c.weekday === weekday && c.hour === hour)

  return (
    <div>
      <h1 className="page-title">学习统计</h1>
      <p className="page-sub">专注时长趋势 · 时段热力图 · 模式对比（数据源 study_stats / sessions）</p>

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
            {trend.length === 0 ? (
              <Empty description="暂无专注记录：完成一次专注会话后这里会出现趋势" />
            ) : (
              <div className="trend-chart">
                {trend.map((t) => (
                  <div className="trend-col" key={t.date} title={`${t.date} · ${t.minutes} 分钟 · ${t.pomos} 番茄`}>
                    <div className="trend-bar-wrap">
                      <div
                        className="trend-bar"
                        style={{ height: `${Math.max(4, (t.minutes / maxMinutes) * 100)}%` }}
                      />
                    </div>
                    <div className="trend-label">{t.date.slice(5)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card size="small" title="🎯 模式对比" className="stats-card">
            {modes.length === 0 ? (
              <Empty description="暂无数据" />
            ) : (
              <div className="mode-compare">
                {modes.map((m) => (
                  <div className="mode-row" key={m.mode}>
                    <span className="mode-name">
                      {m.mode === 'focus' ? '专注' : m.mode === 'bili' ? 'B 站学习' : m.mode === 'english' ? '英语学习' : m.mode}
                    </span>
                    <div className="mode-bar-wrap">
                      <div className="mode-bar" style={{ width: `${(m.minutes / modeMax) * 100}%` }} />
                    </div>
                    <span className="mode-minutes">
                      {Math.round(m.minutes)} 分钟 · {m.pomos} 番茄
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card size="small" title="🌡 时段热力图（星期 × 小时）" className="stats-card">
            {heatmap.length === 0 ? (
              <Empty description="暂无数据（需要已完成的 sessions 记录）" />
            ) : (
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
                      const cell = heatCell(wi, h)
                      const alpha = cell ? Math.min(0.9, 0.12 + (cell.minutes / heatMax) * 0.78) : 0
                      return (
                        <div
                          className="heatmap-cell"
                          key={h}
                          title={cell ? `周${wd} ${h}:00 · ${cell.minutes} 分钟 · ${cell.sessions} 次` : `周${wd} ${h}:00`}
                          style={{
                            background: cell ? `rgba(255, 107, 74, ${alpha})` : 'rgba(42, 49, 60, 0.35)'
                          }}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              颜色越深 = 该时段专注分钟越多。
            </Typography.Text>
          </Card>
        </div>
      </Spin>
    </div>
  )
}

export default StatsPage
