import { useMemo } from 'react'
import { Segmented } from 'antd'
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { PlayStatus } from '../../../../shared/stats'
import { useProgressStore } from '../../store/progressStore'
import { STATUS_META } from './format'

const BAR_COLOR = '#ff6b4a'
const BAR_GOAL_COLOR = '#5aa2ff'
const STATUS_COLORS: Record<PlayStatus, string> = {
  planned: '#8b93a7',
  learning: '#5aa2ff',
  done: '#52c41a'
}
const AXIS_TICK = { fontSize: 10, fill: '#8b93a7' }

interface BarTooltipProps {
  active?: boolean
  payload?: Array<{ payload: { date: string; minutes: number } }>
}

function BarTooltip({ active, payload }: BarTooltipProps): JSX.Element | null {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{p.date}</div>
      <div>
        学习 <span className="chart-tooltip-value">{p.minutes} 分钟</span>
      </div>
    </div>
  )
}

interface PieTooltipProps {
  active?: boolean
  payload?: Array<{ name: string; value: number }>
}

function PieTooltip({ active, payload }: PieTooltipProps): JSX.Element | null {
  if (!active || !payload?.length) return null
  const p = payload[0]
  return (
    <div className="chart-tooltip">
      <div>
        {p.name} <span className="chart-tooltip-value">{p.value} 门</span>
      </div>
    </div>
  )
}

/**
 * 数据可视化（M4）：每日学习时长柱状图（近 7/30 天，达到每日目标高亮）+ 学习状态分布环形图
 * （点击扇区筛选对应状态的记录列表）。recharts 实现，随容器自适应（ResponsiveContainer）。
 */
function ProgressCharts(): JSX.Element {
  const dailyStats = useProgressStore((s) => s.dailyStats)
  const dailyDays = useProgressStore((s) => s.dailyDays)
  const stats = useProgressStore((s) => s.stats)
  const filter = useProgressStore((s) => s.filter)
  const loadDailyStats = useProgressStore((s) => s.loadDailyStats)
  const setFilter = useProgressStore((s) => s.setFilter)

  const barData = useMemo(
    () =>
      dailyStats.map((d) => ({
        date: d.date,
        label: d.date.slice(5), // MM-DD
        minutes: d.minutes
      })),
    [dailyStats]
  )

  const pieData = useMemo(() => {
    const s = stats
    if (!s) return []
    return (['planned', 'learning', 'done'] as PlayStatus[])
      .map((status) => ({
        status,
        name: STATUS_META[status].label,
        value:
          s[
            status === 'planned'
              ? 'plannedCourses'
              : status === 'learning'
                ? 'learningCourses'
                : 'doneCourses'
          ]
      }))
      .filter((d) => d.value > 0)
  }, [stats])

  const goalMinutes = stats?.dailyGoalMinutes ?? 0
  const hasBarData = barData.some((d) => d.minutes > 0)
  const hasPieData = pieData.length > 0

  const handlePieClick = (status: PlayStatus): void => {
    // 点击扇区筛选对应状态；再次点击同一状态恢复全部
    setFilter({ status: filter.status === status ? 'all' : status })
  }

  return (
    <div className="progress-charts">
      <div className="progress-charts-head">
        <span className="progress-charts-title">📈 学习趋势</span>
        <Segmented
          size="small"
          value={dailyDays}
          onChange={(v) => void loadDailyStats(Number(v))}
          options={[
            { value: 7, label: '近 7 天' },
            { value: 30, label: '近 30 天' }
          ]}
        />
      </div>
      <div className="progress-charts-grid">
        <div className="progress-chart-card">
          <div className="progress-chart-card-title">每日学习时长（分钟）</div>
          {hasBarData ? (
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={barData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <XAxis
                  dataKey="label"
                  tick={AXIS_TICK}
                  interval="preserveStartEnd"
                  minTickGap={12}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                  width={34}
                />
                <Tooltip content={<BarTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="minutes" radius={[3, 3, 0, 0]} maxBarSize={18}>
                  {barData.map((d, i) => (
                    <Cell
                      key={i}
                      fill={
                        goalMinutes > 0 && d.minutes >= goalMinutes ? BAR_GOAL_COLOR : BAR_COLOR
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="progress-chart-empty">暂无学习数据，打开视频开始记录</div>
          )}
        </div>
        <div className="progress-chart-card">
          <div className="progress-chart-card-title">学习状态分布（点击筛选）</div>
          {hasPieData ? (
            <ResponsiveContainer width="100%" height={150}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={38}
                  outerRadius={58}
                  paddingAngle={3}
                  stroke="none"
                  onClick={(entry) => handlePieClick((entry as { status: PlayStatus }).status)}
                  style={{ cursor: 'pointer' }}
                >
                  {pieData.map((d) => (
                    <Cell
                      key={d.status}
                      fill={STATUS_COLORS[d.status]}
                      opacity={filter.status === 'all' || filter.status === d.status ? 1 : 0.35}
                    />
                  ))}
                </Pie>
                <Tooltip content={<PieTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="progress-chart-empty">暂无课程记录</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ProgressCharts
