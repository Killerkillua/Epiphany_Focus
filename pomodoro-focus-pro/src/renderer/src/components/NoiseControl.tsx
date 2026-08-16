import { useEffect, useState } from 'react'
import { Button, Card, Divider, Select, Slider, Space, Switch, Typography, message } from 'antd'
import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  SoundOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { noiseEngine } from '../audio'
import { NOISE_PRESETS, getNoisePreset } from '../../../shared/audio'
import type { NoiseSettings, RestAction } from '../../../shared/audio'

/**
 * 白噪音控件（专注模式侧栏常驻）：
 * - 预设选择（合成层 3 种 + 采样层 8 种，素材未打包自动跳过并提示）
 * - 播放/停止、主音量、每轨音量独立混音
 * - 联动配置：专注开始自动播（可配）、休息时暂停/降音量/不变
 * - 全局热键 Ctrl+Shift+↑/↓ 盲操作音量（主进程 globalShortcut → 事件 → 引擎）
 */

const REST_ACTIONS: { value: RestAction; label: string }[] = [
  { value: 'stop', label: '暂停播放' },
  { value: 'duck', label: '降音量' },
  { value: 'none', label: '保持不变' }
]

function NoiseControl(): JSX.Element {
  const [settings, setSettings] = useState<NoiseSettings>(() => noiseEngine.getSettings())
  const [playing, setPlaying] = useState<boolean>(() => noiseEngine.playing)
  const [activeTracks, setActiveTracks] = useState(() => noiseEngine.activeTracks)
  const [assetsReady, setAssetsReady] = useState(false)

  // 引擎状态订阅（音量 / 轨道 / 设置变化时刷新）
  useEffect(() => {
    return noiseEngine.subscribe(() => {
      setSettings(noiseEngine.getSettings())
      setPlaying(noiseEngine.playing)
      setActiveTracks(noiseEngine.activeTracks)
    })
  }, [])

  // 采样素材可用性（未打包的预设禁用提示）
  useEffect(() => {
    void window.api.audio.getAssets().then((assets) => {
      const missing = assets.filter((asset) => !asset.exists).map((asset) => asset.label)
      setAssetsReady(missing.length === 0)
    })
  }, [])

  const presetOptions = NOISE_PRESETS.map((preset) => ({ value: preset.key, label: preset.label }))
  const currentPreset = getNoisePreset(settings.preset)

  const handleTogglePlay = async (): Promise<void> => {
    try {
      const result = await noiseEngine.togglePlay()
      if (result.started === 0 && !noiseEngine.playing) {
        message.warning('所选预设暂无可用音轨：采样素材未打包（resources/audio/），请改用白/粉/棕噪')
      } else if (result.skipped.length > 0) {
        message.info(`已跳过未打包的采样轨：${result.skipped.join('、')}`)
      }
    } catch (err) {
      message.error(`白噪音启动失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <Card size="small" title="白噪音" className="focus-side-card">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* 预设 + 播放 */}
        <Space.Compact style={{ width: '100%' }}>
          <Select
            style={{ flex: 1 }}
            value={settings.preset}
            options={presetOptions}
            disabled={playing}
            onChange={(value) => noiseEngine.setSettings({ preset: value as string })}
          />
          <Button
            type={playing ? 'default' : 'primary'}
            icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            onClick={() => void handleTogglePlay()}
          >
            {playing ? '停止' : '播放'}
          </Button>
        </Space.Compact>

        {/* 主音量 */}
        <div className="noise-row">
          <span className="noise-row-label">
            <SoundOutlined /> 主音量
          </span>
          <Slider
            className="noise-slider"
            min={0}
            max={100}
            value={Math.round(noiseEngine.masterVolume * 100)}
            onChange={(value) => noiseEngine.setMasterVolume(value / 100)}
          />
          <span className="noise-row-value">{Math.round(noiseEngine.masterVolume * 100)}%</span>
        </div>

        {/* 活跃轨道独立混音 */}
        {activeTracks.length > 0 && (
          <div className="noise-tracks">
            <div className="noise-tracks-title">当前音轨（独立混音）</div>
            {activeTracks.map((track) => (
              <div key={track.key} className="noise-row">
                <span className="noise-row-label" title={track.key}>
                  {track.label}
                </span>
                <Slider
                  className="noise-slider"
                  min={0}
                  max={100}
                  value={Math.round(track.volume * 100)}
                  onChange={(value) => noiseEngine.setTrackVolume(track.key, value / 100)}
                />
                <span className="noise-row-value">{Math.round(track.volume * 100)}%</span>
              </div>
            ))}
          </div>
        )}

        <Divider style={{ margin: '4px 0' }} />

        {/* 联动配置 */}
        <div className="noise-row">
          <span className="noise-row-label">
            <ThunderboltOutlined /> 专注开始自动播
          </span>
          <Switch
            size="small"
            checked={settings.autoPlayOnStart}
            onChange={(checked) => noiseEngine.setSettings({ autoPlayOnStart: checked })}
          />
        </div>
        <div className="noise-row">
          <span className="noise-row-label">到点（休息）动作</span>
          <Select
            size="small"
            style={{ width: 130 }}
            value={settings.restAction}
            options={REST_ACTIONS}
            onChange={(value) => noiseEngine.setSettings({ restAction: value as RestAction })}
          />
        </div>

        <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>
          盲操作热键：Ctrl+Shift+↑/↓ 调音量。{assetsReady ? '采样素材已就绪。' : '采样素材（雨/咖啡厅/森林/…）未打包，规格见 resources/audio/README.md。'}
        </Typography.Text>
      </Space>
    </Card>
  )
}

export default NoiseControl
