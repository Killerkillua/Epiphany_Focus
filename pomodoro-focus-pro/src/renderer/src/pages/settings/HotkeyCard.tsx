import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Tag, Typography, message } from 'antd'
import type { ShortcutEntry } from '../../../../shared/shortcuts'
import { IPC_EVENTS } from '../../../../shared/ipc'

/** ⌨️ 快捷键（P1-6）：状态高亮 + 点击录入改键（主进程失败回滚并返回原因） */
export default function HotkeyCard(): JSX.Element {
  const [entries, setEntries] = useState<ShortcutEntry[]>([])
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try { setEntries(await window.api.shortcuts.getStatus()) } catch { /* 主进程未就绪 */ }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => window.api.on<ShortcutEntry[]>(IPC_EVENTS.shortcuts.statusChanged, setEntries), [])

  const apply = useCallback(async (id: string, accelerator: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.shortcuts.setAccelerator(id, accelerator)
      setEntries(res.entries)
      if (!res.ok) message.error(res.error ?? '快捷键修改失败')
      else message.success(res.deferred ? '已保存，下次进入学习会话时生效' : '快捷键已更新')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '快捷键修改失败')
    } finally { setBusy(false); setRecordingId(null) }
  }, [])

  const onRecordKey = (e: React.KeyboardEvent, id: string): void => {
    e.preventDefault()
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
    const mods: string[] = []
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    const raw = e.key
    const key = raw === ' ' ? 'Space' : raw.length === 1 ? raw.toUpperCase() : raw === 'ArrowUp' ? 'Up' : raw === 'ArrowDown' ? 'Down' : raw === 'ArrowLeft' ? 'Left' : raw === 'ArrowRight' ? 'Right' : raw
    if (mods.length === 0) { message.warning('请至少包含 Ctrl/Alt/Shift 之一'); return }
    void apply(id, [...mods, key].join('+'))
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.shortcuts.resetDefaults()
      setEntries(res.entries)
      if (res.ok) message.success('已恢复默认快捷键')
      else message.error(res.error ?? '恢复默认失败')
    } finally { setBusy(false) }
  }

  return (
    <Card size="small" title="⌨️ 快捷键" className="settings-card" extra={<Button size="small" disabled={busy} onClick={() => void reset()}>恢复默认</Button>}>
      {entries.map((en) => (
        <div key={en.id} className="settings-row" style={en.customizable && !en.ok && en.reason?.includes('占用') ? { background: 'rgba(255,77,79,0.08)' } : undefined}>
          <span className="settings-label">{en.label}</span>
          {en.ok ? <Tag color="green">已生效</Tag> : <Tag color={en.reason?.includes('占用') ? 'red' : 'default'}>{en.reason?.includes('占用') ? '被占用' : '未激活'}</Tag>}
          {en.customizable ? (
            <Input
              style={{ width: 240 }}
              value={recordingId === en.id ? '请按下新快捷键…' : en.accelerator}
              disabled={busy}
              readOnly
              placeholder="点击录入新键"
              onFocus={() => setRecordingId(en.id)}
              onBlur={() => setRecordingId((cur) => (cur === en.id ? null : cur))}
              onKeyDown={(e) => recordingId === en.id && onRecordKey(e, en.id)}
            />
          ) : (
            <Typography.Text code>{en.accelerator}</Typography.Text>
          )}
          {!en.customizable && <Typography.Text type="secondary" style={{ fontSize: 12 }}>系统拦截键，不可修改</Typography.Text>}
          {en.customizable && !en.ok && en.reason && <Typography.Text type="danger" style={{ fontSize: 12 }}>{en.reason}，请换一个键位</Typography.Text>}
        </div>
      ))}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        音量键改键立即生效；面板显隐/关闭视频在会话外改键将在下一次进入学习会话时生效（会话中改键即时重注册，失败自动回滚原键）。
      </Typography.Text>
    </Card>
  )
}
