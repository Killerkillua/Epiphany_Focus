import { useState, type Dispatch, SetStateAction } from 'react'
import { AutoComplete, Button, Card, Input, InputNumber, Typography } from 'antd'
import { extractErrorMessage } from '../../utils/errorMessage'
import type { LocalForm, UpdateFn } from './types'

interface AiSettingsCardProps {
  form: LocalForm
  setForm: Dispatch<SetStateAction<LocalForm>>
  saving: boolean
  update: UpdateFn
  /** API Key 留空时回填显示已保存的 Key */
  reload: () => Promise<void>
}

const COMMON_MODELS = [
  { value: 'Qwen/Qwen3-8B' },
  { value: 'Qwen/Qwen3.5-4B' },
  { value: 'Qwen/Qwen2.5-7B-Instruct' },
  { value: 'deepseek-ai/DeepSeek-V3' },
  { value: 'gpt-4o-mini' }
]

/** 🤖 AI 设置（BYOK） */
export default function AiSettingsCard({
  form,
  setForm,
  saving,
  update,
  reload
}: AiSettingsCardProps): JSX.Element {
  const [pinging, setPinging] = useState(false)
  const [pingText, setPingText] = useState('')

  const testConnection = async (): Promise<void> => {
    const patch: Record<string, unknown> = {}
    const baseURL = form.baseURL.trim()
    const model = form.model.trim()
    const key = form.apiKey.trim()
    if (baseURL) patch['ai.baseURL'] = baseURL
    if (model) patch['ai.model'] = model
    if (key && !key.startsWith('••••')) patch['ai.apiKey'] = key
    if (!key) {
      setPingText('请先填写 API Key')
      return
    }
    setPinging(true)
    try {
      if (Object.keys(patch).length > 0) await update(patch)
      const res = await window.api.ai.ping()
      setPingText(res.message)
    } catch (err) {
      setPingText(extractErrorMessage(err))
    } finally {
      setPinging(false)
    }
  }

  return (
    <Card size="small" title="🤖 AI 设置 (BYOK)" className="settings-card">
      <div className="settings-row">
        <span className="settings-label">API 端点</span>
        <Input
          style={{ maxWidth: 480, width: '100%' }}
          value={form.baseURL}
          disabled={saving}
          placeholder="https://api.siliconflow.cn/v1"
          onChange={(e) => setForm((f) => ({ ...f, baseURL: e.target.value }))}
          onBlur={(e) => void update({ 'ai.baseURL': e.target.value.trim() }, 'AI 端点已更新')}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">API Key</span>
        <Input.Password
          style={{ maxWidth: 480, width: '100%' }}
          value={form.apiKey}
          disabled={saving}
          placeholder="留空 = 保留已保存 Key（不回显）"
          onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          onBlur={(e) => {
            const v = e.target.value.trim()
            // 以掩码开头 = 回填的已保存 Key 未被修改，无需提交
            if (v && !v.startsWith('••••')) {
              void update({ 'ai.apiKey': v }, 'API Key 已更新')
            } else {
              // 空输入：保留已保存的 Key，回填显示（避免误清空默认配置）
              void reload()
            }
          }}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">对话模型</span>
        <AutoComplete
          style={{ maxWidth: 480, width: '100%' }}
          value={form.model}
          disabled={saving}
          options={COMMON_MODELS}
          placeholder="Qwen/Qwen3-8B"
          onChange={(val) => setForm((f) => ({ ...f, model: val }))}
          onBlur={() => void update({ 'ai.model': form.model.trim() }, '对话模型已更新')}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">连接</span>
        <Button size="small" loading={pinging} disabled={saving} onClick={() => void testConnection()}>
          测试连接
        </Button>
        {pingText && (
          <Typography.Text type={pingText === '连接成功' ? 'success' : 'danger'} style={{ fontSize: 12 }}>
            {pingText}
          </Typography.Text>
        )}
      </div>
      <div className="settings-row">
        <span className="settings-label">OCR 模型</span>
        <AutoComplete
          style={{ maxWidth: 480, width: '100%' }}
          value={form.ocrModel}
          disabled={saving}
          options={COMMON_MODELS}
          placeholder="Qwen/Qwen3-8B"
          onChange={(val) => setForm((f) => ({ ...f, ocrModel: val }))}
          onBlur={() => void update({ 'ai.ocrModel': form.ocrModel.trim() }, 'OCR 模型已更新')}
        />
      </div>
      <div className="settings-row">
        <span className="settings-label">单会话上限</span>
        <InputNumber
          min={1}
          max={500}
          style={{ width: 120 }}
          value={form.maxQuestionsPerSession}
          disabled={saving}
          onChange={(v) => void update({ 'ai.maxQuestionsPerSession': Number(v ?? 50) })}
        />
      </div>
    </Card>
  )
}
