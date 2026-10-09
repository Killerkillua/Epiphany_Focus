import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  assertLocalMediaFile,
  issueMediaToken,
  resetMediaTokens,
  resolveMediaToken
} from './localMediaStore'

describe('本地媒体令牌', () => {
  beforeEach(() => {
    resetMediaTokens()
  })

  it('拒绝不支持的扩展名，接受 mp4 并隐藏为令牌', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tomato-media-'))
    const mp4 = join(dir, 'lesson.mp4')
    writeFileSync(mp4, Buffer.from('fake-mp4'))
    const file = assertLocalMediaFile(mp4)
    expect(file.resourceKey.startsWith('local:')).toBe(true)
    expect(file.title).toBe('lesson.mp4')
    expect(file.unreliable).toBe(false)
    const token = issueMediaToken(file)
    expect(resolveMediaToken(token.token)?.filePath).toBe(file.realPath)
    expect(resolveMediaToken('../etc/passwd')).toBeNull()
    expect(resolveMediaToken(token.token, token.expiresAt + 1)).toBeNull()
    expect(() => assertLocalMediaFile(join(dir, 'notes.txt'))).toThrow()
  })

  it('mkv 与 flv 标记为不可靠格式', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tomato-media-'))
    const mkv = join(dir, 'lesson.mkv')
    writeFileSync(mkv, Buffer.from('fake-mkv'))
    expect(assertLocalMediaFile(mkv).unreliable).toBe(true)
  })
})
