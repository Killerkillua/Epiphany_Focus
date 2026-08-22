export interface ModeCardProps {
  /** 单字/短图标（emoji 或 icon 组件） */
  mark: string
  title: string
  tagline: string
  /** 个性化亮点，用于卡片底部 */
  highlights: string[]
  accent: string
  onClick: () => void
}

function ModeCard(p: ModeCardProps): JSX.Element {
  return (
    <button className="mode-card" onClick={p.onClick} style={{ borderLeftColor: p.accent }}>
      <div className="mode-mark">{p.mark}</div>
      <div className="mode-title">{p.title}</div>
      <div className="mode-tagline">{p.tagline}</div>
      <ul className="mode-highlights">
        {p.highlights.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
      <span className="mode-cta">开始 →</span>
    </button>
  )
}

export default ModeCard
