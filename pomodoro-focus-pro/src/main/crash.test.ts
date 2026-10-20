import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { buildDiagnosticZip, buildSentryEnvelope, parseSentryDsn, scrubCrashText, scrubCrashValue } from './crash'

describe('crash scrub', () => {
  it('剔除路径、密钥、bvid', () => {
    const s = scrubCrashText('fail C:\\Users\\kk\\secret.txt apiKey=abc123 BV1xx411c7mD')
    expect(s).not.toContain('kk')
    expect(s).not.toContain('abc123')
    expect(s).not.toContain('BV1xx411c7mD')
    expect(s).toContain('[redacted]')
  })
  it('对象按敏感键脱敏', () => {
    const v = scrubCrashValue({ ai: { apiKey: 'x' }, note: 'ok' }) as { ai: { apiKey: string } }
    expect(v.ai.apiKey).toBe('[redacted]')
  })
})

describe('sentry envelope', () => {
  it('解析 DSN 并构建 envelope 且已脱敏', () => {
    expect(parseSentryDsn('not-a-url')).toBeNull()
    const env = buildSentryEnvelope('https://pub@example.com/42', { kind: 'test', message: 'boom C:\\a\\b' })
    expect(env).toContain('"type":"event"')
    expect(env).not.toContain('C:\\a')
  })
})

describe('diagnostic zip', () => {
  const dir = join(tmpdir(), `pomodoro-crash-test-${Date.now()}`)
  beforeEach(() => {
    mkdirSync(dir, { recursive: true })
    process.env.POMODORO_LOG_DIR = dir
    process.env.POMODORO_CRASH_DIR = join(dir, 'Crashpad')
    mkdirSync(process.env.POMODORO_CRASH_DIR, { recursive: true })
    writeFileSync(join(dir, 'app.log'), 'hello log', 'utf8')
    writeFileSync(join(process.env.POMODORO_CRASH_DIR, 'dump.dmp'), 'minidump', 'utf8')
  })
  afterEach(() => {
    delete process.env.POMODORO_LOG_DIR
    delete process.env.POMODORO_CRASH_DIR
    rmSync(dir, { recursive: true, force: true })
  })
  it('打包日志与 minidump', async () => {
    const target = join(dir, 'diag.zip')
    await buildDiagnosticZip(target)
    expect(existsSync(target)).toBe(true)
    const zip = await JSZip.loadAsync(readFileSync(target))
    expect(zip.file('manifest.json')).toBeTruthy()
    expect(zip.file('app.log')).toBeTruthy()
    expect(zip.file('crashdumps/dump.dmp')).toBeTruthy()
  })
})
