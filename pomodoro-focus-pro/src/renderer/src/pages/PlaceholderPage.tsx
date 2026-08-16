interface PlaceholderPageProps {
  title: string
  icon: string
  description: string
}

/** 未开发页面通用占位 */
function PlaceholderPage({ title, icon, description }: PlaceholderPageProps): JSX.Element {
  return (
    <div>
      <h1 className="page-title">{title}</h1>
      <p className="page-sub">{description}</p>
      <div className="placeholder-wrap">
        <div className="placeholder-icon">{icon}</div>
        <div>该模块尚未接入（骨架阶段占位）</div>
      </div>
    </div>
  )
}

export default PlaceholderPage
