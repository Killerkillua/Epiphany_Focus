import { useState } from 'react'
import StatsBar from '../components/StatsBar'
import ModeCard from '../components/ModeCard'
import DurationConfigModal, { type ModeTarget } from '../components/DurationConfigModal'
import { useFocusStore } from '../store/focusStore'
import { useSessionStore } from '../store/sessionStore'

interface Props {
  onNavigate: (page: 'focus' | 'bili' | 'english') => void
}

function HomePage({ onNavigate }: Props): JSX.Element {
  const [target, setTarget] = useState<ModeTarget | null>(null)
  const focusStart = useFocusStore((s) => s.start)
  const sessionStart = useSessionStore((s) => s.start)
  // 番茄/学习会话完成后的统计刷新由 statsStore 统一订阅（StatsBar 挂载即激活）

  const handleConfirm = async (minutes: number): Promise<void> => {
    const t = target
    setTarget(null)
    if (!t) return
    if (t === 'focus') {
      await focusStart('countdown', minutes * 60_000)
    } else {
      // B 站 / 英语模式：进入页面即启动学习会话计时（与强制引擎解耦）
      await sessionStart(t, minutes * 60_000)
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
          accent="#FF5588"
          tagline="输入学习主题，进入锁定网页学习"
          highlights={['WBI 搜索', '导航管控', 'AI 助手 + 记事本']}
          onClick={() => setTarget('bili')}
        />
        <ModeCard
          mark="A"
          title="英语学习"
          accent="#FF6B35"
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