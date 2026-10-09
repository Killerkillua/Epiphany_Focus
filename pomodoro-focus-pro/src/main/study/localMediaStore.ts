import { createHash, randomBytes } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isSelectableMediaName, mediaExtension, UNRELIABLE_MEDIA_EXTENSIONS } from '../../shared/study'

export const MAX_LOCAL_MEDIA_BYTES = 8 * 1024 * 1024 * 1024
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000

export interface MediaTokenRecord {
  token: string
  filePath: string
  resourceKey: string
  title: string
  extension: string
  expiresAt: number
}

const tokens = new Map<string, MediaTokenRecord>()

export function assertLocalMediaFile(filePath: string): {
  realPath: string
  title: string
  extension: string
  resourceKey: string
  unreliable: boolean
} {
  if (!filePath || filePath.includes('\0')) throw new Error('路径无效')
  let realPath = ''
  try {
    realPath = realpathSync(filePath)
  } catch {
    throw new Error('找不到该文件')
  }
  if (!isSelectableMediaName(realPath)) throw new Error('只支持 mp4 / mkv / webm / flv / m4v / mov')
  const stat = statSync(realPath)
  if (!stat.isFile()) throw new Error('请选择视频文件')
  if (stat.size <= 0) throw new Error('文件是空的')
  if (stat.size > MAX_LOCAL_MEDIA_BYTES) throw new Error('文件超过 8 GB')
  const extension = mediaExtension(realPath)
  const slash = Math.max(realPath.lastIndexOf('/'), realPath.lastIndexOf('\\'))
  const title = slash >= 0 ? realPath.slice(slash + 1) : realPath
  const fingerprint = createHash('sha256')
    .update(`${realPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 32)
  return {
    realPath,
    title,
    extension,
    resourceKey: `local:${fingerprint}`,
    unreliable: UNRELIABLE_MEDIA_EXTENSIONS.has(extension)
  }
}

export function issueMediaToken(file: {
  realPath: string
  resourceKey: string
  title: string
  extension: string
}): MediaTokenRecord {
  const token = randomBytes(16).toString('hex')
  const record: MediaTokenRecord = {
    token,
    filePath: file.realPath,
    resourceKey: file.resourceKey,
    title: file.title,
    extension: file.extension,
    expiresAt: Date.now() + TOKEN_TTL_MS
  }
  tokens.set(token, record)
  return record
}

export function resolveMediaToken(token: string, now = Date.now()): MediaTokenRecord | null {
  if (!/^[a-f0-9]{32}$/.test(token)) return null
  const record = tokens.get(token)
  if (!record || record.expiresAt <= now) {
    if (record) tokens.delete(token)
    return null
  }
  return record
}

export function revokeMediaToken(token: string): void {
  tokens.delete(token)
}

/** 测试用：清空内存令牌。 */
export function resetMediaTokens(): void {
  tokens.clear()
}
