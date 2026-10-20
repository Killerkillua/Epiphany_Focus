import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import type { CrashReportPayload, DiagnosticExportResult } from '../shared/crash'
import { logger, getLogFilePath } from './logger'

/**
 * P1-5 崩溃收集（第一层零后端 + 可选远程）。
 * - Native: crashReporter 本地 minidump（uploadToServer:false），落 crashDumps/Crashpad。
 * - 远程: 仅 crashReportEnabled=true 且构建环境注入 DSN 时，Sentry 协议 envelope
 *   直发（兼容 Sentry SaaS / GlitchTip），不新增 SDK 依赖；DSN 绝不写死。
 * - 脱敏: 上报/落日志前 scrub 路径、apiKey/token/恢复码、bvid。
 */

const SENSITIVE_KEY = /(api[_-]?key|apikey|token|password|passwd|secret|recovery|恢复码)/i

export function scrubCrashText(input: string): string {
  return input
    .replace(/[A-Za-z]:\\(?:[^\s"'\\]+\\)*[^\s"'\\]*/g, '[path]')
    .replace(/\/(?:Users|home)\/[^\s"']+/g, '[path]')
    .replace(/\bBV[0-9A-Za-z]{10}\b/g, '[bvid]')
    .replace(
      /((?:api[_-]?key|apikey|token|password|secret|recovery\w*)\s*[:=]\s*)\S+/gi,
      '$1[redacted]'
    )
}

export function scrubCrashValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return scrubCrashText(value).slice(0, 4000)
  if (value instanceof Error)
    return { name: value.name, message: scrubCrashText(value.message), stack: scrubCrashText(value.stack ?? '').slice(0, 4000) }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubCrashValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrubCrashValue(v, depth + 1)
    }
    return out
  }
  return value
}

export function parseSentryDsn(dsn: string): { url: string; publicKey: string; projectId: string } | null {
  try {
    const u = new URL(dsn)
    const projectId = u.pathname.replace(/\//g, '')
    if (!u.username || !projectId) return null
    return {
      url: `${u.protocol}//${u.host}/api/${projectId}/envelope/?sentry_key=${u.username}&sentry_version=7`,
      publicKey: u.username,
      projectId
    }
  } catch {
    return null
  }
}

export function buildSentryEnvelope(dsn: string, report: CrashReportPayload & { release?: string }): string | null {
  const parsed = parseSentryDsn(dsn)
  if (!parsed) return null
  const eventId = randomUUID().replace(/-/g, '')
  const header = { event_id: eventId, dsn, sdk: { name: 'pomodoro.crash', version: '1.0.0' } }
  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    release: report.release,
    exception: {
      values: [
        {
          type: scrubCrashText(report.kind).slice(0, 100),
          value: scrubCrashText(report.message).slice(0, 1000),
          stacktrace: report.stack ? { frames: [] } : undefined
        }
      ]
    },
    extra: { stack: report.stack ? scrubCrashText(report.stack).slice(0, 4000) : undefined, source: report.source }
  }
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event', length: JSON.stringify(event).length })}\n${JSON.stringify(event)}`
}

type ElectronModule = typeof import('electron')

function electron(): ElectronModule | null {
  try {
     
    return require('electron') as ElectronModule
  } catch {
    return null
  }
}

export function getCrashDumpsDir(): string {
  if (process.env.POMODORO_CRASH_DIR) return process.env.POMODORO_CRASH_DIR
  const el = electron()
  try {
    if (el?.app && typeof el.app.getPath === 'function') {
      try {
        return el.app.getPath('crashDumps')
      } catch {
        return join(el.app.getPath('userData'), 'Crashpad')
      }
    }
  } catch {
    /* test env */
  }
  return join(process.cwd(), '.crashpad')
}

let started = false

/** 必须在 app.whenReady 之前调用（index.ts 顶部）。重复调用无副作用。 */
export function startNativeCrashReporter(): boolean {
  if (started) return true
  const el = electron()
  if (!el?.crashReporter) return false
  try {
    el.crashReporter.start({ productName: '静界专注', uploadToServer: false, compress: true })
    started = true
    return true
  } catch (err) {
    logger.error('crash', 'crashReporter 启动失败', scrubCrashValue(err))
    return false
  }
}

export function isRemoteCrashEnabled(): { enabled: boolean; dsn: string } {
  let enabled = false
  try {
     
    const { getSettings } = require('./storage/settings') as typeof import('./storage/settings')
    enabled = getSettings().crashReportEnabled === true
  } catch {
    enabled = false
  }
  const dsn = process.env.POMODORO_CRASH_DSN ?? process.env.SENTRY_DSN ?? ''
  return { enabled, dsn }
}

/** 统一上报入口：先脱敏落本地日志；开启远程且有 DSN 时 best-effort 发送，失败静默。 */
export function reportCrash(kind: string, error: unknown, extra?: Record<string, unknown>): void {
  const payload: CrashReportPayload = {
    kind,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  }
  const clean = scrubCrashValue({ ...payload, extra }) as Record<string, unknown>
  logger.error('crash', `${kind}: ${String(clean.message ?? '')}`, clean)
  const { enabled, dsn } = isRemoteCrashEnabled()
  if (!enabled || !dsn) return
  const envelope = buildSentryEnvelope(dsn, {
    kind,
    message: payload.message,
    stack: payload.stack,
    source: typeof extra?.source === 'string' ? extra.source : undefined
  })
  if (!envelope) return
  const parsed = parseSentryDsn(dsn)
  if (!parsed) return
  try {
    void fetch(parsed.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}` },
      body: envelope,
      signal: AbortSignal.timeout(3000)
    }).catch(() => undefined)
  } catch {
    /* 上报失败不影响应用 */
  }
}

function collectFiles(dir: string, prefix: string, out: Array<{ name: string; data: Buffer }>, depth = 0): void {
  if (depth > 3 || !existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (out.length >= 50) return
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (st.isDirectory()) collectFiles(full, `${prefix}${name}/`, out, depth + 1)
      else if (st.size <= 10 * 1024 * 1024) out.push({ name: `${prefix}${name}`, data: readFileSync(full) })
    } catch {
      /* 单文件失败跳过 */
    }
  }
}

/** 打包 app.log(+轮转) + minidump 目录为 zip；供导出诊断包与单测复用。 */
export async function buildDiagnosticZip(targetPath: string): Promise<void> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  const el = electron()
  let version = 'unknown'
  try {
    version = el?.app?.getVersion?.() ?? version
  } catch {
    /* ignore */
  }
  zip.file(
    'manifest.json',
    JSON.stringify(
      { app: '静界专注', version, platform: process.platform, exportedAt: new Date().toISOString(), logSha256: createHash('sha256').update(getLogFilePath()).digest('hex').slice(0, 8) },
      null,
      2
    )
  )
  for (const p of [getLogFilePath(), `${getLogFilePath()}.1`]) {
    if (existsSync(p)) zip.file(p.split(/[\\/]/).pop() ?? 'app.log', readFileSync(p))
  }
  const dumps: Array<{ name: string; data: Buffer }> = []
  collectFiles(getCrashDumpsDir(), 'crashdumps/', dumps)
  for (const f of dumps) zip.file(f.name, f.data)
  if (dumps.length === 0) zip.file('crashdumps/README.txt', '无本地 minidump（尚未发生 native 崩溃）。')
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  writeFileSync(targetPath, buf)
}

export function registerCrashIpc(): void {
  ipcMain.handle(IPC_CHANNELS.crash.reportRenderer, (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return false
    const p = payload as Partial<CrashReportPayload>
    reportCrash(
      typeof p.kind === 'string' ? p.kind.slice(0, 100) : 'renderer',
      p.stack ? Object.assign(new Error(String(p.message ?? 'renderer error')), { stack: String(p.stack) }) : String(p.message ?? 'renderer error'),
      { source: typeof p.source === 'string' ? p.source : 'renderer' }
    )
    return true
  })
  ipcMain.handle(IPC_CHANNELS.crash.exportDiagnostics, async (event): Promise<DiagnosticExportResult> => {
    try {
      const { BrowserWindow } = electron() ?? {}
      const owner = BrowserWindow?.fromWebContents(event.sender) ?? undefined
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const result = owner
        ? await dialog.showSaveDialog(owner, { title: '导出诊断包', defaultPath: `jingjie-diagnostics-${stamp}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] })
        : await dialog.showSaveDialog({ title: '导出诊断包', defaultPath: `jingjie-diagnostics-${stamp}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      await buildDiagnosticZip(result.filePath)
      return { ok: true, filePath: result.filePath }
    } catch (err) {
      logger.error('crash', '导出诊断包失败', scrubCrashValue(err))
      return { ok: false, error: '导出诊断包失败' }
    }
  })
}
