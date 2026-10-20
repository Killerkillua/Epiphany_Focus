import { useEffect, useState } from 'react'
import { Button, Card, Dropdown, Empty, Input, Space, Switch, Typography, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined } from '@ant-design/icons'
import type { VocabEntry } from '../../../shared/ai'
import type { VocabExportFormat } from '../../../shared/export'
import { useEnglishStore } from '../store/englishStore'
import { extractErrorMessage } from '../utils/errorMessage'

const { TextArea } = Input

/** 与主进程 vocab.definition 校验一致 */
const DEFINITION_MAX = 2000

/**
 * 记事本里的生词本：单词或短语列表，释义可手填。
 * 「显示释义」关掉时列表不露出释义；点编辑时始终看见并修改，与总开关分开。
 */
function VocabNotebook(): JSX.Element {
  const [items, setItems] = useState<VocabEntry[]>([])
  const [showDefinitions, setShowDefinitions] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async (): Promise<void> => {
    const list = await window.api.ai.listVocab()
    setItems(list)
    useEnglishStore.setState({ vocab: list })
  }

  useEffect(() => {
    void load().catch((err) => message.error(extractErrorMessage(err)))
  }, [])

  const exportVocab = async (format: VocabExportFormat): Promise<void> => {
    try {
      const res = await window.api.export.vocab({ format })
      if (res.canceled) return
      if (res.ok) message.success(format === 'apkg' ? '已导出 Anki 卡包' : '已导出 Anki 文本')
      else message.error(res.error ?? '导出失败')
    } catch (err) {
      message.error(extractErrorMessage(err))
    }
  }

  const startEdit = (entry: VocabEntry): void => {
    setEditingId(entry.id)
    setDraft(entry.definition)
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setDraft('')
  }

  const saveDefinition = async (id: number): Promise<void> => {
    const definition = draft.trim()
    if (definition.length > DEFINITION_MAX) {
      message.warning(`释义超过 ${DEFINITION_MAX} 字`)
      return
    }
    setSaving(true)
    try {
      await window.api.ai.updateVocab({ id, definition })
      await load()
      cancelEdit()
      message.success('释义已保存')
    } catch (err) {
      message.error(extractErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number): Promise<void> => {
    try {
      await window.api.ai.deleteVocab(id)
      if (editingId === id) cancelEdit()
      await load()
    } catch (err) {
      message.error(extractErrorMessage(err))
    }
  }

  return (
    <Card size="small" className="notes-card vocab-notebook">
      <div className="vocab-notebook-toolbar">
        <Space size={8}>
          <Switch
            size="small"
            checked={showDefinitions}
            onChange={setShowDefinitions}
            aria-label="显示释义"
          />
          <span>显示释义</span>
        </Space>
        <Space size={4}>
          <VocabExportButton disabled={items.length === 0} onExport={exportVocab} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {items.length}
          </Typography.Text>
        </Space>
      </div>
      <Typography.Text type="secondary" className="vocab-side-hint">
        在英语学习模式里选中对话文字即可加入。释义在这里填写。
      </Typography.Text>

      {items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有生词。到英语学习模式选中对话中的单词或短语加入"
        />
      ) : (
        <ul className="vocab-notebook-list">
          {items.map((entry) => {
            const editing = editingId === entry.id
            return (
              <li key={entry.id} className="vocab-notebook-item">
                <div className="vocab-notebook-head">
                  <span className="vocab-notebook-word">{entry.word}</span>
                  <Space size={4}>
                    {editing ? (
                      <>
                        <Button
                          size="small"
                          type="primary"
                          loading={saving}
                          onClick={() => void saveDefinition(entry.id)}
                        >
                          保存
                        </Button>
                        <Button size="small" disabled={saving} onClick={cancelEdit}>
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="small"
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() => startEdit(entry)}
                      >
                        编辑
                      </Button>
                    )}
                    <Button
                      size="small"
                      type="text"
                      icon={<DeleteOutlined />}
                      disabled={saving && editing}
                      onClick={() => void remove(entry.id)}
                    />
                  </Space>
                </div>
                {editing ? (
                  <TextArea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="填写释义"
                    autoSize={{ minRows: 2, maxRows: 6 }}
                  />
                ) : showDefinitions ? (
                  <p className="vocab-notebook-def">
                    {entry.definition || '暂无释义，点编辑添加'}
                  </p>
                ) : (
                  <p className="vocab-notebook-mask">释义已遮蔽</p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function VocabExportButton({
  disabled,
  onExport
}: {
  disabled: boolean
  onExport: (format: VocabExportFormat) => Promise<void>
}): JSX.Element {
  return (
    <Dropdown
      disabled={disabled}
      menu={{
        items: [
          { key: 'apkg', label: 'Anki 卡包 (.apkg)' },
          { key: 'txt', label: 'Anki 文本 (.txt)' }
        ],
        onClick: ({ key }) => void onExport(key === 'txt' ? 'txt' : 'apkg')
      }}
    >
      <Button size="small" icon={<DownloadOutlined />} disabled={disabled}>
        导出
      </Button>
    </Dropdown>
  )
}

export default VocabNotebook
