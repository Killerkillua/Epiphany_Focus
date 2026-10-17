import { Modal, message } from 'antd'
import type { VocabEntry } from '../../../shared/ai'
import type { VocabExportFormat } from '../../../shared/export'
import { extractErrorMessage } from './errorMessage'

/** Anki Back 由 definition + example 组成；两者皆空则背面空白 */
export function vocabBackEmpty(
  entry: Pick<VocabEntry, 'definition' | 'example'>
): boolean {
  return !entry.definition.trim() && !entry.example.trim()
}

/**
 * 导出前若存在空 Back 词条则确认；取消则不调用主进程。
 */
export async function exportVocabWithBackGuard(
  entries: Array<Pick<VocabEntry, 'definition' | 'example'>>,
  format: VocabExportFormat
): Promise<void> {
  const empty = entries.filter(vocabBackEmpty).length
  if (empty > 0) {
    const ok = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: '部分词条 Anki 背面为空',
        content: `有 ${empty} 条没有释义和例句，导出后 Back 会空白。建议先到记事本填写释义。仍要导出吗？`,
        okText: '仍要导出',
        cancelText: '先去填写',
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })
    if (!ok) return
  }

  try {
    const res = await window.api.export.vocab({ format })
    if (res.canceled) return
    if (res.ok) message.success(format === 'apkg' ? '已导出 Anki 卡包' : '已导出 Anki 文本')
    else message.error(res.error ?? '导出失败')
  } catch (err) {
    message.error(extractErrorMessage(err))
  }
}
