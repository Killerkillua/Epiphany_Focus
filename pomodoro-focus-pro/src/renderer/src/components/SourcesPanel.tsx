import { Collapse } from 'antd'
import type { AiSource } from '../../../shared/ai'

/** 参考来源折叠面板 */
function SourcesPanel({ sources }: { sources: AiSource[] }): JSX.Element | null {
  if (!sources || sources.length === 0) return null
  return (
    <div className="sources-panel">
      <Collapse
        size="small"
        ghost
        items={[
          {
            key: 'sources',
            label: `📚 参考来源（${sources.length}）`,
            children: (
              <ul className="sources-list">
                {sources.map((s, i) => (
                  <li key={i}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title}
                    </a>
                    {s.snippet && <div className="sources-snippet">{s.snippet}</div>}
                  </li>
                ))}
              </ul>
            )
          }
        ]}
      />
    </div>
  )
}

export default SourcesPanel
