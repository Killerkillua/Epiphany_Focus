import { useEffect } from 'react'
import { useStatsStore } from '../store/statsStore'

function formatMinutes(m: number): string {
  if (!m) return '0m'
  const h = Math.floor(m / 60)
  const mm = m % 60
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`
}

function StatsBar(): JSX.Element {
  const summary = useStatsStore((s) => s.summary)
  const error = useStatsStore((s) => s.error)
  // 首次加载前（summary 为空且无错误）显示骨架；后续事件触发为静默刷新，不闪烁
  const loading = !summary && !error
  const failed = !summary && !!error

  useEffect(() => {
    void useStatsStore.getState().loadSummary()
  }, [])

  const dash = failed ? '—' : '--'

  return (
    <>
      <div className="stats-bar">
        <StatCard
          loading={loading}
          dimmed={failed}
          label="今日专注"
          value={summary ? formatMinutes(summary.todayMinutes) : dash}
        />
        <StatCard
          loading={loading}
          dimmed={failed}
          label="完成番茄"
          value={summary ? String(summary.todayPomos) : dash}
        />
        <StatCard
          loading={loading}
          dimmed={failed}
          label="连续天数"
          value={summary ? String(summary.streakDays) : dash}
        />
      </div>
      {failed && <p className="stats-error">{error}</p>}
    </>
  )
}

function StatCard(p: {
  loading: boolean
  dimmed?: boolean
  label: string
  value: string
}): JSX.Element {
  return (
    <div className={`stat-card${p.loading ? ' loading' : ''}`}>
      <div className={`stat-value${p.dimmed ? ' placeholder' : ''}`}>{p.value}</div>
      <div className="stat-label">{p.label}</div>
    </div>
  )
}

export default StatsBar
