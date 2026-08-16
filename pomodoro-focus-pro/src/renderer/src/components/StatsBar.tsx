import { useEffect } from 'react'
import { useHomeStore } from '../store/homeStore'

function formatMinutes(m: number): string {
  if (!m) return '0m'
  const h = Math.floor(m / 60)
  const mm = m % 60
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`
}

function StatsBar(): JSX.Element {
  const { summary, loading, load } = useHomeStore()
  useEffect(() => { void load() }, [load])

  return (
    <div className="stats-bar">
      <StatCard
        loading={loading}
        label="今日专注"
        value={summary ? formatMinutes(summary.todayMinutes) : '--'}
      />
      <StatCard
        loading={loading}
        label="完成番茄"
        value={summary ? String(summary.todayPomos) : '--'}
      />
      <StatCard
        loading={loading}
        label="连续天数"
        value={summary ? String(summary.streakDays) : '--'}
      />
    </div>
  )
}

function StatCard(p: { loading: boolean; label: string; value: string }): JSX.Element {
  return (
    <div className={`stat-card${p.loading ? ' loading' : ''}`}>
      <div className="stat-value">{p.value}</div>
      <div className="stat-label">{p.label}</div>
    </div>
  )
}

export default StatsBar