import { dialog } from 'electron'
import type { LocalMediaPickResult } from '../../shared/study'
import { assertLocalMediaFile, issueMediaToken, type MediaTokenRecord } from './localMediaStore'

export async function pickLocalMedia(): Promise<
  | { canceled: true }
  | {
      canceled: false
      file: ReturnType<typeof assertLocalMediaFile>
      token: MediaTokenRecord
      warning?: string
    }
> {
  const picked = await dialog.showOpenDialog({
    title: '选择本地学习视频',
    properties: ['openFile'],
    filters: [
      { name: '视频', extensions: ['mp4', 'mkv', 'webm', 'flv', 'm4v', 'mov'] },
      { name: '推荐格式 MP4', extensions: ['mp4'] }
    ]
  })
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true }
  const file = assertLocalMediaFile(picked.filePaths[0])
  const token = issueMediaToken(file)
  const warning = file.unreliable
    ? `${file.extension.toUpperCase()} 通常无法由内置播放器直接播放。若无法播放，请先无损转封装或转换为 H.264/AAC MP4。`
    : undefined
  return { canceled: false, file, token, warning }
}

export function toPickResult(
  picked: Awaited<ReturnType<typeof pickLocalMedia>>
): LocalMediaPickResult {
  if (picked.canceled) return { canceled: true }
  return {
    canceled: false,
    resourceKey: picked.file.resourceKey,
    title: picked.file.title,
    extension: picked.file.extension,
    unreliable: picked.file.unreliable,
    warning: picked.warning
  }
}
