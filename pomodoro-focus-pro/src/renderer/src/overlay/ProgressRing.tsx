/**
 * SVG 进度环（轻量，无依赖）：用于悬浮球学习计时角标 / 进度页当前视频进度。
 * 渲染纯 SVG + CSS 变量色，不引入额外库。
 */
interface ProgressRingProps {
  /** 进度 0..1 */
  ratio: number
  size?: number
  stroke?: number
  /** 轨道色（默认表面色） */
  trackColor?: string
  /** 进度色（默认品牌色） */
  progressColor?: string
  /** 无障碍标签 */
  label?: string
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0
  return Math.max(0, Math.min(1, ratio))
}

export function ProgressRing({
  ratio,
  size = 40,
  stroke = 4,
  trackColor = 'var(--bg-hover, #232a36)',
  progressColor = 'var(--brand, #ff6b4a)',
  label = `学习进度 ${Math.round(clampRatio(ratio) * 100)}%`
}: ProgressRingProps): JSX.Element {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = clampRatio(ratio)
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      className="progress-ring"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={trackColor}
        strokeWidth={stroke}
        fill="none"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={progressColor}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)' }}
      />
    </svg>
  )
}

/** 秒数 → m:ss / h:mm:ss 友好格式 */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}
