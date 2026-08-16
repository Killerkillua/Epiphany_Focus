import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Divider,
  Input,
  InputNumber,
  message,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Typography
} from 'antd'
import type { AppSettings, BiliStrictness, EndAction, LockLevel } from '../../../shared/settings'
import { LEVEL_LABEL } from '../../../main/enforcement/level'

/**
 * 设置页（方案 4.2）：合并全部配置，写 electron-store，即时生效。
 * 各主进程模块在使用时动态读取 settings，无需重启。
 */

interface LocalForm {
  lockLevel: LockLevel
  endAction: EndAction
  sessionMaxHours: number
  focusMin: number
  shortBreakMin: number
  longBreakMin: number
  longBreakEvery: number
  strictness: BiliStrictness
  autoFullscreen: boolean
  baseURL: string
  apiKey: string
  model: string
  ocrModel: string
  maxQuestionsPerSession: number
  noisePreset: string
  hasCode: boolean
}

const EMPTY: LocalForm = {
  lockLevel: 'L1',
  endAction: 'overlay',
  sessionMaxHours: 4,
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  strictness: 'standard',
  autoFullscreen: true,
  baseURL: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'Qwen/Qwen3.5-4B',
  ocrModel: 'Qwen/Qwen3.5-4B',
  maxQuestionsPerSession: 50,
  noisePreset: 'rain',
  hasCode: false
}

const NOISE_OPTIONS = [
  { value: 'white', label: '白噪' },
  { value: 'pink', label: '粉噪' },
  { value: 'brown', label: '棕噪' },
  { value: 'rain', label: '雨声' },
  { value: 'cafe', label: '咖啡厅' },
  { value: 'forest', label: '森林' },
  { value: 'library', label: '图书馆' }
]

function SettingsPage(): JSX.Element {
  const [form, setForm] = useState<LocalForm>(EMPTY)
  const [codeOpen, setCodeOpen] = useState(false)
  const [code1, setCode1] = useState('')
  const [code2, setCode2] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async (): Promise<void> => {
    const s: AppSettings = await window.api.settings.get()
    setForm({
      lockLevel: s.lockLevel,
      endAction: s.endAction,
      sessionMaxHours: s.sessionMaxHours,
      focusMin: s.pomodoro.focusMin,
      shortBreakMin: s.pomodoro.shortBreakMin,
      longBreakMin: s.pomodoro.longBreakMin,
      longBreakEvery: s.pomodoro.longBreakEvery,
      strictness: s.bili.strictness,
      autoFullscreen: s.bili.autoFullscreen,
      baseURL: s.ai.baseURL,
      apiKey: s.ai.apiKey,
      model: s.ai.model,
      ocrModel: s.ai.ocrModel,
      maxQuestionsPerSession: s.ai.maxQuestionsPerSession,
      noisePreset: s.noisePreset,
      hasCode: !!s.recoveryCodeHash
    })
  }

  useEffect(() => {
    void load()
  }, [])

  /** 即时生效：写入 electron-store */
  const update = async (entries: Record<string, unknown>, tip?: string): Promise<void> => {
    setSaving(true)
    try {
      await window.api.settings.set(entries)
      if (tip) message.success(tip)
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSetCode = async (): Promise<void> => {
    if (code1.length < 6) {
      message.warning('恢复码至少 6 位')
      return
    }
    if (code1 !== code2) {
      message.warning('两次输入不一致')
      return
    }
    try {
      await window.api.emergency.setCode(code1)
      message.success('紧急恢复码已保存（bcrypt 哈希存储）')
      setCodeOpen(false)
      setCode1('')
      setCode2('')
      await load()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '设置失败')
    }
  }

  const numberRow = (
    label: string,
    dottedKey: string,
    value: number,
    min = 1,
    max = 120
  ): JSX.Element => (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <InputNumber
        min={min}
        max={max}
        value={value}
        disabled={saving}
        onChange={(v) => void update({ [dottedKey]: Number(v ?? min) })}
      />
    </div>
  )

  return (
    <div>
      <h1 className="page-title">设置</h1>
      <p className="page-sub">全部配置即时生效（electron-store 持久化）</p>

      <div className="settings-layout">
        <Card size="small" title="🔒 强制控制（方案 2.5）" className="settings-card">
          <div className="settings-row">
            <span className="settings-label">锁定级别</span>
            <Radio.Group
              value={form.lockLevel}
              disabled={saving}
              onChange={(e) => void update({ lockLevel: e.target.value as LockLevel }, '锁定级别已更新')}
            >
              <Radio value="L0">L0 轻量</Radio>
              <Radio value="L1">L1 标准</Radio>
              <Radio value="L2">L2 强化</Radio>
            </Radio.Group>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {LEVEL_LABEL[form.lockLevel]}
          </Typography.Text>
          <Divider style={{ margin: '10px 0' }} />
          <div className="settings-row">
            <span className="settings-label">到点动作</span>
            <Select
              style={{ width: 180 }}
              value={form.endAction}
              disabled={saving}
              options={[
                { value: 'lock', label: '锁屏' },
                { value: 'overlay', label: '全屏遮罩（保持）' },
                { value: 'notify', label: '仅提示' }
              ]}
              onChange={(v) => void update({ endAction: v as EndAction }, '到点动作已更新')}
            />
          </div>
          {numberRow('会话上限（小时）', 'sessionMaxHours', form.sessionMaxHours, 1, 24)}
          <Divider style={{ margin: '10px 0' }} />
          <div className="settings-row">
            <span className="settings-label">紧急恢复码</span>
            <Space>
              <Typography.Text type={form.hasCode ? 'success' : 'warning'}>
                {form.hasCode ? '已设置（bcrypt 哈希）' : '未设置'}
              </Typography.Text>
              <Button size="small" onClick={() => setCodeOpen(true)}>
                {form.hasCode ? '修改' : '设置'}
              </Button>
            </Space>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            L1/L2 强制会话开始前必须已设置恢复码；连按 5 次 Esc 触发紧急退出。
          </Typography.Text>
        </Card>

        <Card size="small" title="🍅 番茄钟参数" className="settings-card">
          {numberRow('专注时长（分钟）', 'pomodoro.focusMin', form.focusMin)}
          {numberRow('短休息（分钟）', 'pomodoro.shortBreakMin', form.shortBreakMin, 1, 30)}
          {numberRow('长休息（分钟）', 'pomodoro.longBreakMin', form.longBreakMin, 5, 60)}
          {numberRow('长休息间隔（个番茄）', 'pomodoro.longBreakEvery', form.longBreakEvery, 2, 20)}
        </Card>

        <Card size="small" title="📺 B 站模式" className="settings-card">
          <div className="settings-row">
            <span className="settings-label">内容相关度档位</span>
            <Select
              style={{ width: 160 }}
              value={form.strictness}
              disabled={saving}
              options={[
                { value: 'strict', label: '严格' },
                { value: 'standard', label: '标准' },
                { value: 'loose', label: '宽松' }
              ]}
              onChange={(v) => void update({ 'bili.strictness': v as BiliStrictness }, '相关度档位已更新')}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">点击视频自动全屏</span>
            <Switch
              checked={form.autoFullscreen}
              disabled={saving}
              onChange={(v) => void update({ 'bili.autoFullscreen': v }, '自动全屏已更新')}
            />
          </div>
        </Card>

        <Card size="small" title="🤖 AI 设置（BYOK）" className="settings-card">
          <div className="settings-row">
            <span className="settings-label">API 端点</span>
            <Input
              style={{ width: 320 }}
              value={form.baseURL}
              disabled={saving}
              onChange={(e) => setForm((f) => ({ ...f, baseURL: e.target.value }))}
              onBlur={(e) => void update({ 'ai.baseURL': e.target.value.trim() }, 'AI 端点已更新')}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">API Key</span>
            <Input.Password
              style={{ width: 320 }}
              value={form.apiKey}
              disabled={saving}
              placeholder="留空 = 保留已保存 Key（不回显）"
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v) {
                  void update({ 'ai.apiKey': v }, 'API Key 已更新')
                } else {
                  // 空输入：保留已保存的 Key，回填显示（避免误清空默认配置）
                  void load()
                }
              }}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">对话模型</span>
            <Input
              style={{ width: 200 }}
              value={form.model}
              disabled={saving}
              placeholder="Qwen/Qwen3.5-4B"
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              onBlur={(e) => void update({ 'ai.model': e.target.value.trim() }, '对话模型已更新')}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">OCR 模型</span>
            <Input
              style={{ width: 200 }}
              value={form.ocrModel}
              disabled={saving}
              placeholder="Qwen/Qwen3.5-4B"
              onChange={(e) => setForm((f) => ({ ...f, ocrModel: e.target.value }))}
              onBlur={(e) => void update({ 'ai.ocrModel': e.target.value.trim() }, 'OCR 模型已更新')}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">单会话提问上限</span>
            <InputNumber
              min={1}
              max={500}
              value={form.maxQuestionsPerSession}
              disabled={saving}
              onChange={(v) => void update({ 'ai.maxQuestionsPerSession': Number(v ?? 50) })}
            />
          </div>
        </Card>

        <Card size="small" title="🎧 白噪音" className="settings-card">
          <div className="settings-row">
            <span className="settings-label">默认预设</span>
            <Select
              style={{ width: 160 }}
              value={form.noisePreset}
              disabled={saving}
              options={NOISE_OPTIONS}
              onChange={(v) => void update({ noisePreset: v }, '白噪音预设已更新')}
            />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            合成层（白/粉/棕噪）即时可用；采样层需打包 resources/audio 素材后自动生效。
          </Typography.Text>
        </Card>
      </div>

      <Modal
        title="设置紧急恢复码"
        open={codeOpen}
        onOk={() => void handleSetCode()}
        onCancel={() => setCodeOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            恢复码用于强制会话紧急退出（连按 5 次 Esc 触发）。至少 6 位，仅存 bcrypt 哈希。
          </Typography.Text>
          <Input.Password placeholder="新恢复码（至少 6 位）" value={code1} onChange={(e) => setCode1(e.target.value)} />
          <Input.Password placeholder="再次输入" value={code2} onChange={(e) => setCode2(e.target.value)} />
        </Space>
      </Modal>
    </div>
  )
}

export default SettingsPage
