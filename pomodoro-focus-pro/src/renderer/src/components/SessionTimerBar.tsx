import { useEffect, useState } from 'react'
import { Button, Card, InputNumber, Progress, Space, message } from 'antd'
import { PauseCircleOutlined, CaretRightOutlined, StopOutlined } from '@ant-design/icons'
import { useSessionStore } from '../store/sessionStore'
import { useShallow } from 'zustand/react/shallow'
import { noiseEngine } from '../audio'
import { playChime } from '../audio/chime'
import { getNoisePreset } from '../../../shared/audio'
import type { SessionMode } from '../../../shared/types'

const MINUTE = 60 * 1000
const PRESETS = [15, 30, 60, 120]

const MODE_META: Record<SessionMode, { title: string; icon: string; hint: string }> = {
  bili: {
    title: '视频学习会话',
    icon: '📺',
    hint: '倒计时结束将自动关闭视频窗口并休息'
  },
  study: {
    title: '视频学习会话',
    icon: '📺',
    hint: '倒计时结束将自动关闭学习窗口并休息'
  },
  english: {
    title: '英语学习会话',
    icon: '📖',
    hint: '倒计时结束将提示休息，学习时长计入统计'
  }
}

const MODE_ACCENT: Record<SessionMode, string> = {
  bili: 'var(--accent)',
  study: 'var(--accent)',
  english: 'var(--accent2)'
}

/** mm:ss（超过 1 小时显示 h:mm:ss） */
function formatMs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

interface Props {
  /** 当前页面所属模式（决定空闲态的默认文案与强调色） */
  mode: SessionMode
}

/**
 * 学习会话计时条（视频学习 / 英语学习模式）。
 * - 空闲：预设时长 + 开始按钮（首页进入时已由时长弹窗启动，此处用于直达页面）
 * - 进行中：倒计时 + 进度条 + 暂停/继续/结束
 * - 到点：提示音 + 消息 + 白噪音联动；主进程同步桌面通知与统计落库
 */
function SessionTimerBar({ mode }: Props): JSX.Element {
  // H-06：细粒度 selector 订阅，只订阅所需字段；snapshot 每秒变化，其余字段不受其连带重渲染
  const snapshot = useSessionStore((s) => s.snapshot)
  const storeMode = useSessionStore((s) => s.mode)
  const justCompleted = useSessionStore((s) => s.justCompleted)
  // 动作引用稳定（Zustand 不随 tick 重建），用 useShallow 合并取整组动作，避免对象字面量触发重渲染
  const { init, start, pause, resume, stop, clearCompleted } = useSessionStore(
    useShallow((s) => ({
      init: s.init,
      start: s.start,
      pause: s.pause,
      resume: s.resume,
      stop: s.stop,
      clearCompleted: s.clearCompleted
    }))
  )

  const [pendingMin, setPendingMin] = useState(60)

  const inSession = snapshot.status !== 'idle'
  const running = snapshot.status === 'running'
  const paused = snapshot.status === 'paused'
  const finished = snapshot.status === 'finished'
  const currentMode: SessionMode = inSession || finished ? storeMode : mode
  const meta = MODE_META[currentMode]
  const accent = MODE_ACCENT[currentMode]

  useEffect(() => {
    void init()
  }, [init])

  // 到点：提示音 + 消息 + 白噪音休息联动（视频学习不联动白噪音）
  useEffect(() => {
    if (justCompleted) {
      playChime()
      if (currentMode !== 'bili') {
        const restAction = noiseEngine.getSettings().restAction
        if (restAction === 'stop') {
          noiseEngine.stopAll()
        } else if (restAction === 'duck') {
          noiseEngine.duck()
        }
      }
      void message.success(`🍅 ${meta.title}完成，休息一下吧！`)
      clearCompleted()
    }
  }, [justCompleted, meta.title, clearCompleted, currentMode])

  const percent =
    snapshot.durationMs > 0 ? Math.min(100, (snapshot.elapsedMs / snapshot.durationMs) * 100) : 0
  const statusText = finished
    ? '本轮完成 🎉'
    : running
      ? '学习中 · 倒计时'
      : paused
        ? '已暂停'
        : `未开始 · ${meta.hint}`

  const handleStart = (): void => {
    const minutes = Math.max(1, Math.min(480, Math.round(pendingMin) || 60))
    void start(currentMode, minutes * MINUTE)
      .then(() => {
        if (currentMode === 'bili') {
          // 视频学习不需要白噪音开启，且确保立即停止当前可能播放的白噪音
          noiseEngine.stopAll()
        } else {
          // 白噪音联动：英语学习会话开始自动播放（可配）+ 恢复音量（解除休息降音量）
          noiseEngine.restore()
          if (noiseEngine.getSettings().autoPlayOnStart) {
            void noiseEngine
              .playPreset(getNoisePreset(noiseEngine.getSettings().preset))
              .then((result) => {
                if (result.started === 0 && result.skipped.length > 0) {
                  void message.info(`白噪音：${result.skipped.join('、')} 素材未打包，已跳过`)
                }
              })
          }
        }
      })
      .catch((err: unknown) => {
        void message.error(err instanceof Error ? err.message : '开始失败')
      })
  }

  return (
    <Card size="small" className="session-bar">
      <div className="session-bar-inner">
        <div className="session-bar-title">
          <span className="session-bar-icon">{meta.icon}</span>
          <span>{meta.title}</span>
        </div>

        {!inSession && !finished ? (
          /* ===== 空闲态：预设时长 + 自定义输入 + 开始 ===== */
          <div className="session-bar-idle">
            <Space size={6} wrap>
              {PRESETS.map((m) => (
                <Button
                  key={m}
                  size="small"
                  type={pendingMin === m ? 'primary' : 'default'}
                  onClick={() => setPendingMin(m)}
                >
                  {m} 分钟
                </Button>
              ))}
            </Space>
            <div className="session-bar-custom">
              <span className="session-bar-custom-label">自定义</span>
              <InputNumber
                min={1}
                max={480}
                precision={0}
                value={pendingMin}
                onChange={(v) => v !== null && setPendingMin(v)}
                style={{ width: 130 }}
                addonAfter="分钟"
              />
            </div>
            <Button type="primary" onClick={handleStart}>
              开始计时
            </Button>
          </div>
        ) : (
          /* ===== 进行中 / 完成态 ===== */
          <>
            <div
              className={`session-bar-timer${running ? ' active' : ''}`}
              style={{ color: running ? accent : undefined }}
            >
              {formatMs(snapshot.remainingMs)}
            </div>
            <div className="session-bar-progress">
              <Progress
                percent={Math.round(percent)}
                showInfo={false}
                strokeColor={accent}
                trailColor="var(--rule)"
                size="small"
              />
              <div className="session-bar-status">{statusText}</div>
            </div>
            <div className="session-bar-controls">
              {running && (
                <Button size="small" icon={<PauseCircleOutlined />} onClick={() => void pause()}>
                  暂停
                </Button>
              )}
              {paused && (
                <Button
                  size="small"
                  type="primary"
                  icon={<CaretRightOutlined />}
                  onClick={() => void resume()}
                >
                  继续
                </Button>
              )}
              {(running || paused) && (
                <Button
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  onClick={() => {
                    // 白噪音闭环：非视频模式手动结束时停止播放
                    if (currentMode !== 'bili') {
                      noiseEngine.stopAll()
                    }
                    void stop()
                  }}
                >
                  结束
                </Button>
              )}
              {finished && (
                <Button type="primary" onClick={handleStart}>
                  再来一轮
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

export default SessionTimerBar
