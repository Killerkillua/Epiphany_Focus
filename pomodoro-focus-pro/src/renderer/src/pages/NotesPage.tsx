import { useEffect, useRef, useState } from 'react'
import { Button, Card, Empty, Input, Space, Typography, message } from 'antd'
import {
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  SaveOutlined,
  ScanOutlined
} from '@ant-design/icons'
import type { NoteEntry } from '../../../shared/bili'

const { TextArea } = Input

/**
 * 记事本：按 id 增量保存 / 删除，导出当前草稿或全部笔记 Markdown 压缩包，
 * 图片文字识别（OCR 模型）：选择图片或直接粘贴剪贴板截图。
 */

function NotesPage(): JSX.Element {
  const [entries, setEntries] = useState<NoteEntry[]>([])
  const [currentId, setCurrentId] = useState<string>('main')
  const [draft, setDraft] = useState('')
  const [ocrBusy, setOcrBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async (): Promise<void> => {
    try {
      const list = await window.api.notes.load()
      setEntries(list)
      // 聚焦最新一条（新模型按 created_at DESC 返回，list[0] 为最新）；空库则创建一条草稿
      const target = list[0] ?? { id: 'main', createdAt: Date.now(), content: '' }
      setCurrentId(target.id)
      setDraft(target.content)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载笔记失败')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async (tip = true): Promise<boolean> => {
    try {
      // 只提交当前一条，保留 bvid / resourceKey / videoTitle / isKey / timestampS / source。
      // 不再把渲染层手里的整表当作应有集合，避免另一窗口刚写入的笔记被删掉。
      const existing = entries.find((e) => e.id === currentId)
      const saved = await window.api.notes.upsert({
        ...existing,
        id: currentId,
        createdAt: existing?.createdAt ?? Date.now(),
        content: draft,
        source: existing?.source ?? 'main'
      })
      setEntries((prev) =>
        prev.some((e) => e.id === saved.id)
          ? prev.map((e) => (e.id === saved.id ? saved : e))
          : [saved, ...prev]
      )
      if (tip) message.success('笔记已保存')
      return true
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
      return false
    }
  }

  const newNote = async (): Promise<void> => {
    const ok = await save(false)
    if (!ok) return
    const entry: NoteEntry = {
      id: `n-${Date.now()}`,
      createdAt: Date.now(),
      content: '',
      source: 'main'
    }
    try {
      const saved = await window.api.notes.upsert(entry)
      setEntries((prev) => [saved, ...prev.filter((e) => e.id !== saved.id)])
      setCurrentId(saved.id)
      setDraft('')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '新建笔记失败')
    }
  }

  const removeNote = async (id: string): Promise<void> => {
    try {
      await window.api.notes.delete(id)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败')
      return
    }
    const next = entries.filter((e) => e.id !== id)
    setEntries(next)
    if (id === currentId) {
      const target = next[0] ?? { id: 'main', createdAt: Date.now(), content: '' }
      setCurrentId(target.id)
      setDraft(target.content)
    }
  }

  const exportMarkdown = (): void => {
    const blob = new Blob([draft], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `笔记-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    // 推迟到下载触发后再释放：a.click() 的下载由浏览器异步接管，
    // 同步栈内 revokeObjectURL 可能导致部分浏览器取消下载
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    message.success('已导出 Markdown')
  }

  const exportAllNotes = async (): Promise<void> => {
    try {
      const res = await window.api.export.notesMarkdown()
      if (res.canceled) return
      if (res.ok) message.success('已导出全部笔记')
      else message.error(res.error ?? '导出失败')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '导出失败')
    }
  }

  /** 图片文件 → dataURL → OCR → 追加到编辑区 */
  const ocrImage = async (file: File): Promise<void> => {
    setOcrBusy(true)
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('图片读取失败'))
        reader.readAsDataURL(file)
      })
      const result = await window.api.ai.ocr({ image: dataUrl })
      if (!result.ok) {
        message.error(result.error ?? '识别失败')
        return
      }
      const block = `\n\n> 🖼️ ${file.name}（OCR ${new Date().toLocaleString()}）\n\n${result.text}\n`
      setDraft((d) => (d.trim() ? d + block : block))
      message.success('识别完成，已插入编辑区（记得保存）')
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'OCR 失败')
    } finally {
      setOcrBusy(false)
    }
  }

  /** 监听剪贴板粘贴：图片直接 OCR，文本照常 */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file && !ocrBusy) {
        e.preventDefault()
        void ocrImage(file)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocrBusy])

  return (
    <div>
      <h1 className="page-title">记事本</h1>
      <p className="page-sub">学习笔记 · 自动保存 · 图片 OCR 识别 · Markdown 导出</p>

      <Card size="small" className="notes-card">
        {/* 工具栏 */}
        <Space wrap style={{ marginBottom: 12 }}>
          <Button type="primary" size="small" icon={<SaveOutlined />} onClick={() => void save()}>
            保存
          </Button>
          <Button
            size="small"
            icon={<FileImageOutlined />}
            loading={ocrBusy}
            onClick={() => fileRef.current?.click()}
          >
            图片 OCR
          </Button>
          <Button size="small" icon={<ScanOutlined />} onClick={() => void newNote()}>
            新建笔记
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={exportMarkdown}>
            导出当前
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => void exportAllNotes()}>
            导出全部笔记
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {entries.length} 条笔记 · 可直接粘贴截图（Ctrl+V）自动识别
          </Typography.Text>
        </Space>

        {/* 笔记列表 */}
        {entries.length > 0 && (
          <Space wrap size={[8, 4]} style={{ marginBottom: 10 }}>
            {entries.map((e) => (
              <Button
                key={e.id}
                size="small"
                type={e.id === currentId ? 'primary' : 'default'}
                onClick={() => {
                  void save(false)
                  setCurrentId(e.id)
                  setDraft(e.content)
                }}
                icon={
                  <DeleteOutlined
                    style={{ fontSize: 10, opacity: 0.65 }}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void removeNote(e.id)
                    }}
                  />
                }
              >
                {new Date(e.createdAt).toLocaleDateString()}
              </Button>
            ))}
          </Space>
        )}

        {/* 编辑区 */}
        <TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save(false)}
          placeholder={
            '记录学习要点…\n\n提示：复制任意截图/图片后直接 Ctrl+V，将自动调用 OCR 识别并插入文字。'
          }
          autoSize={{ minRows: 14, maxRows: 26 }}
          className="notes-editor"
        />
      </Card>

      {/* 隐藏的文件选择 */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void ocrImage(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export default NotesPage
