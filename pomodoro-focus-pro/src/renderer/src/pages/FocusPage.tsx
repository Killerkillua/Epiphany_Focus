import { useEffect, useState } from 'react'
import { Button, Card, message, Segmented, Select, Space, Switch, Typography } from 'antd'
import { useFocusStore } from '../store/focusStore'
import NoiseControl from '../components/NoiseControl'
import { noiseEngine } from '../audio'
import { playChime } from '../audio/chime'
import { getNoisePreset } from '../../../shared/audio'
import type { TimerMode } from '../../../shared/types'

const MINUTE = 60 * 1000
const DURATION_OPTIONS = [25, 45, 60]

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

function FocusPage(): JSX.Element {
  const {
    snapshot,
    alwaysOnTop,
    distraction,
    justCompleted,
    init,
    start,
    pause,
    resume,
    stop,
    setAlwaysOnTop,
    setDistraction,
    clearCompleted
  } = useFocusStore()

  // 开始前的本地配置（会话进行中锁定）；默认专注时长从全局设置读取（方案 4.2）
  const [mode, setMode] = useState<TimerMode>('countdown')
  const [durationMin, setDurationMin] = useState(25)
  const [lockLevel, setLockLevel] = useState('L1')
  const [endAction, setEndAction] = useState('overlay')

  const inSession = snapshot.status !== 'idle'
  const running = snapshot.status === 'running'
  const paused = snapshot.status === 'paused'
  const finished = snapshot.status === 'finished'

  useEffect(() => {
    void init()
    void (async () => {
      try {
        const s = await window.api.settings.get()
        setDurationMin(s.pomodoro.focusMin)
        setLockLevel(s.lockLevel)
        setEndAction(s.endAction)
      } catch {
        // 设置读取失败时保持默认值
      }
    })()
  }, [init])

  // 到点：提示音 + 消息 + 白噪音休息联动（暂停 / 降音量 / 不变）
  useEffect(() => {
    if (justCompleted) {
      playChime()
      const restAction = noiseEngine.getSettings().restAction
      if (restAction === 'stop') {
        noiseEngine.stopAll()
      } else if (restAction === 'duck') {
        noiseEngine.duck()
      }
      void message.success(
        snapshot.longRestSuggestion ? '🍅 一组完成！建议长休息 15 分钟' : '🍅 专注完成，休息一下吧！'
      )
      clearCompleted()
    }
  }, [justCompleted, snapshot.longRestSuggestion, clearCompleted])

  // 大号计时显示：进行中用主进程快照；未开始按本地配置预览
  const displayMs = inSession
    ? snapshot.mode === 'countdown'
      ? snapshot.remainingMs
      : snapshot.elapsedMs
    : mode === 'countdown'
      ? durationMin * MINUTE
      : 0

  const statusText = finished
    ? '本轮完成 🍅'
    : running
      ? snapshot.mode === 'countdown'
        ? '专注中 · 逆序计时'
        : '专注中 · 正序计时'
      : paused
        ? '已暂停'
        : mode === 'countdown'
          ? `逆序计时 · ${durationMin} 分钟`
          : '正序计时 · 自由累加'

  const handleStart = (): void => {
    void start(mode, durationMin * MINUTE)
      .then(() => {
        // 白噪音联动：专注开始自动播放（可配）+ 恢复音量（解除休息降音量）
        noiseEngine.restore()
        if (noiseEngine.getSettings().autoPlayOnStart) {
          void noiseEngine.playPreset(getNoisePreset(noiseEngine.getSettings().preset)).then((result) => {
            if (result.started === 0 && result.skipped.length > 0) {
              void message.info(`白噪音：${result.skipped.join('、')} 素材未打包，已跳过`)
            }
          })
        }
      })
      .catch((err: unknown) => {
        // 前置失败（如 L1/L2 未设置紧急恢复码）
        void message.error(err instanceof Error ? err.message : '开始失败')
      })
  }

  const endActionLabel = endAction === 'lock' ? '锁屏' : endAction === 'overlay' ? '全屏遮罩' : '仅提示'

  return (
    <div>
      <h1 className="page-title">专注模式</h1>
      <p className="page-sub">
        番茄计时 · 锁定级别 {lockLevel} · 到点{endActionLabel} · 分心应用拦截
      </p>

      <div className="focus-layout">
        {/* ===== 主计时卡片 ===== */}
        <div className="focus-card">
          <div className="focus-config">
            <Segmented
              options={[
                { label: '逆序计时', value: 'countdown' },
                { label: '正序计时', value: 'countup' }
              ]}
              value={mode}
              disabled={inSession}
              onChange={(v) => setMode(v as TimerMode)}
            />
            {mode === 'countdown' && (
              <Segmented
                options={DURATION_OPTIONS.map((m) => ({ label: `${m} 分钟`, value: m }))}
                value={durationMin}
                disabled={inSession}
                onChange={(v) => setDurationMin(v as number)}
              />
            )}
          </div>

          <div className={`focus-timer${running ? ' active' : ''}`}>{formatMs(displayMs)}</div>

          <div className="focus-status">
            {statusText}
            {snapshot.longRestSuggestion && (
              <span className="focus-rest-hint"> · 建议长休息 15 分钟</span>
            )}
          </div>

          <div className="pomo-dots">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`pomo-dot${i < snapshot.completedPomodoros ? ' done' : ''}`}
              />
            ))}
          </div>
          <div className="pomo-label">番茄 {snapshot.completedPomodoros}/4</div>

          <div className="focus-controls">
            {!inSession && (
              <Button type="primary" size="large" onClick={handleStart}>
                {finished ? '再来一轮' : '开始专注'}
              </Button>
            )}
            {running && (
              <Button size="large" onClick={() => void pause()}>
                暂停
              </Button>
            )}
            {paused && (
              <Button type="primary" size="large" onClick={() => void resume()}>
                继续
              </Button>
            )}
            {(running || paused) && (
              <Button danger size="large" onClick={() => { noiseEngine.restore(); void stop() }}>
                结束
              </Button>
            )}
            {finished && (
              <Button size="large" onClick={() => void stop()}>
                回到初始
              </Button>
            )}
          </div>
        </div>

        {/* ===== 右侧控制面板 ===== */}
        <div className="focus-side">
          <Card size="small" title="窗口行为" className="focus-side-card">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space>
                <Switch
                  checked={alwaysOnTop}
                  onChange={(v) => void setAlwaysOnTop(v)}
                  checkedChildren="置顶"
                  unCheckedChildren="普通"
                />
                <Typography.Text>窗口置顶（L0/L1）</Typography.Text>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                开始专注时自动置顶，结束/结束时自动恢复普通层级；不强制全屏。
              </Typography.Text>
            </Space>
          </Card>

          <Card size="small" title="分心应用拦截（Windows）" className="focus-side-card">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Switch
                checked={distraction.enabled}
                onChange={(v) => void setDistraction({ enabled: v })}
                checkedChildren="拦截中"
                unCheckedChildren="已关闭"
              />
              <div className="field-label">黑名单（命中即 taskkill /F）</div>
              <Select
                mode="tags"
                style={{ width: '100%' }}
                value={distraction.blacklist}
                placeholder="如 chrome、msedge、wechat"
                onChange={(v) => void setDistraction({ blacklist: v as string[] })}
              />
              <div className="field-label">白名单（豁免）</div>
              <Select
                mode="tags"
                style={{ width: '100%' }}
                value={distraction.whitelist}
                placeholder="如 code、devenv、obsidian"
                onChange={(v) => void setDistraction({ whitelist: v as string[] })}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                每 2 秒检测一次带窗口的进程；白名单优先于黑名单；系统关键进程与软件自身永不结束。
              </Typography.Text>
            </Space>
          </Card>

          {/* 白噪音控件（Web Audio 多轨混音 + 无缝循环 + 联动配置） */}
          <NoiseControl />
        </div>
      </div>
    </div>
  )
}

export default FocusPage
