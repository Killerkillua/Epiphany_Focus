import { useEffect, useState } from 'react'
import StatsBar from '../components/StatsBar'
import ModeCard from '../components/ModeCard'
import DurationConfigModal, { type ModeTarget } from '../components/DurationConfigModal'
import { useFocusStore } from '../store/focusStore'
import { useHomeStore } from '../store/homeStore'

interface Props {
  onNavigate: (page: 'focus' | 'bili' | 'english') => void
}

function HomePage({ onNavigate }: Props): JSX.Element {
  const [target, setTarget] = useState<ModeTarget | null>(null)
  const focusStart = useFocusStore((s) => s.start)
  const { load } = useHomeStore()

  // 订阅 timer:complete 事件，番茄结束后即时刷新统计条
  useEffect(() => {
    return window.api.on('timer:complete', () => {
      void load()
    })
  }, [load])

  const handleConfirm = async (minutes: number): Promise<void> => {
    const t = target
    setTarget(null)
    if (!t) return
    if (t === 'focus') {
      await focusStart('countdown', minutes * 60_000)
    }
    onNavigate(t)
  }

  return (
    <div className="home">
      <h1 className="page-title">首页</h1>
      <p className="page-sub">欢迎使用番茄专注 Pro —— 想学就学，无法摸鱼。</p>

      <StatsBar />

      <div className="mode-grid">
        <ModeCard
          mark="▶"
          title="B 站学习"
          accent="#ff6b4a"
          tagline="输入学习主题，进入锁定网页学习"
          highlights={['WBI 搜索', '导航管控', 'AI 助手 + 记事本']}
          onClick={() => setTarget('bili')}
        />
        <ModeCard
          mark="A"
          title="英语学习"
          accent="#4da3ff"
          tagline="与 AI 母语者对话，分层教学"
          highlights={['分层 Prompt', 'RAG 权威词典', '生词本']}
          onClick={() => setTarget('english')}
        />
        <ModeCard
          mark="⚡"
          title="专注模式"
          accent="#3ddc97"
          tagline="正/逆序计时 + 番茄循环"
          highlights={['分心拦截', '白噪音联动', '强制锁定']}
          onClick={() => setTarget('focus')}
        />
      </div>

      <DurationConfigModal
        open={!!target}
        mode={target}
        defaultMin={25}
        onCancel={() => setTarget(null)}
        onConfirm={handleConfirm}
      />
    </div>
  )
}

export default HomePage