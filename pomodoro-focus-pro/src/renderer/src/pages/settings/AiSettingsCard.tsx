import type { Dispatch, SetStateAction } from 'react'
import { Card, Input, InputNumber } from 'antd'
import type { LocalForm, UpdateFn } from './types'

interface AiSettingsCardProps {
  form: LocalForm
  setForm: Dispatch<SetStateAction<LocalForm>>
  saving: boolean
  update: UpdateFn
  /** API Key 留空时回填显示已保存的 Key */
  reload: () => Promise<void>
}

/** 🤖 AI 设置（BYOK） */
export default function AiSettingsCard({
  form,
  setForm,
  saving,
  update,
  reload
}: AiSettingsCardProps): JSX.Element {
  return (
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
              void reload()
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
  )
}
