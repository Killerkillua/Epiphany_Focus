import { protocol } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { resolveMediaToken } from './localMediaStore'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.flv': 'video/x-flv'
}

function mimeOf(extension: string): string {
  return MIME[extension] ?? 'application/octet-stream'
}

function streamResponse(
  filePath: string,
  mime: string,
  start: number,
  end: number,
  size: number,
  status: number
): Response {
  const nodeStream = createReadStream(filePath, { start, end })
  const body = Readable.toWeb(nodeStream) as ReadableStream
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes'
  }
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status, headers })
}

/**
 * tomato-media://play/<token>
 * URL 中只有内存令牌，不包含文件系统路径。未知、过期或带路径穿越的令牌一律拒绝。
 */
export function handleTomatoMediaRequest(request: Request): Response {
  let token = ''
  try {
    const url = new URL(request.url)
    if (url.hostname !== 'play') return new Response('not found', { status: 404 })
    token = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    return new Response('bad request', { status: 400 })
  }
  if (token.includes('..') || token.includes('/') || token.includes('\\')) {
    return new Response('bad request', { status: 400 })
  }
  const record = resolveMediaToken(token)
  if (!record) return new Response('not found', { status: 404 })
  let size = 0
  try {
    const stat = statSync(record.filePath)
    if (!stat.isFile()) return new Response('not found', { status: 404 })
    size = stat.size
  } catch {
    return new Response('not found', { status: 404 })
  }
  const mime = mimeOf(record.extension)
  const range = request.headers.get('range')
  if (!range) return streamResponse(record.filePath, mime, 0, size - 1, size, 200)
  const match = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || end < start || end >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  return streamResponse(record.filePath, mime, start, end, size, 206)
}

export function installLocalMediaProtocol(): void {
  protocol.handle('tomato-media', (request) => handleTomatoMediaRequest(request))
}
