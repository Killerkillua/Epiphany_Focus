import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import {
  canonicalWebUrl,
  draftSiteRuleFromText,
  webResourceKey,
  type OpenWebStudyPayload
} from '../../shared/study'
import { normalizeLearningUrl } from '../../shared/study'
import { assertExitSafety } from '../enforcement/emergencyExit'
import { getPlaySourceUri } from '../storage/db'
import { getSettings } from '../storage/settings'
import { num, optNum, optStr, safeRecord, str } from '../validate'
import { pickLocalMedia } from './localMedia'
import { assertLocalMediaFile, issueMediaToken, resolveMediaToken } from './localMediaStore'
import { openLearningContent } from './learningWindow'
import { judgeLearningUrl } from './siteGuard'
import { matchSiteRule } from '../../shared/study'

function plannedMsOf(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const ms = num(value, 'study.plannedMs')
  if (ms < 0 || ms > 24 * 60 * 60 * 1000) throw new Error('学习时长超出范围')
  return ms
}

/**
 * 本地视频与白名单网站 IPC。
 * 打开动作复用学习窗口壳；B 站搜索失败不会阻止这两个入口注册。
 */
export function registerStudyModule(getWindow: () => BrowserWindow | null): void {
  void getWindow

  ipcMain.handle(IPC_CHANNELS.study.pickLocal, async () => {
    const picked = await pickLocalMedia()
    if (picked.canceled) return { canceled: true }
    return {
      canceled: false,
      resourceKey: picked.file.resourceKey,
      title: picked.file.title,
      extension: picked.file.extension,
      unreliable: picked.file.unreliable,
      warning: picked.warning,
      token: picked.token.token
    }
  })

  ipcMain.handle(IPC_CHANNELS.study.openLocal, (_event, raw: unknown): void => {
    const body = safeRecord(raw)
    const token = str(body.token, 'study.openLocal.token', { max: 64 })
    const resourceKey = str(body.resourceKey, 'study.openLocal.resourceKey', { max: 80 })
    const title = str(body.title, 'study.openLocal.title', { max: 500 })
    const issued = resolveMediaToken(token)
    if (!resourceKey.startsWith('local:') || !issued || issued.resourceKey !== resourceKey) {
      throw new Error('本地视频凭证无效或已过期')
    }
    assertExitSafety(getSettings().lockLevel)
    openLearningContent({
      kind: 'local',
      resourceKey,
      recordId: resourceKey,
      title,
      topic: optStr(body.topic, 'study.openLocal.topic', { max: 500 }),
      autoFullscreen: body.autoFullscreen !== false,
      plannedMs: plannedMsOf(body.plannedMs),
      seekSeconds: optNum(body.seekSeconds, 'study.openLocal.seekSeconds'),
      source: 'manual',
      mediaToken: token,
      sourceUri: issued.filePath
    })
  })

  ipcMain.handle(IPC_CHANNELS.study.openWeb, (_event, raw: unknown): void => {
    const body = safeRecord(raw) as Partial<OpenWebStudyPayload>
    const normalized = normalizeLearningUrl(str(body.url, 'study.openWeb.url', { max: 2000 }))
    if (!normalized.ok) throw new Error(normalized.reason)
    const rules = getSettings().learning.sites.filter((rule) => rule.enabled)
    const verdict = judgeLearningUrl(normalized.url.href, rules)
    if (!verdict.allowed) throw new Error(verdict.reason)
    assertExitSafety(getSettings().lockLevel)
    const canonical = canonicalWebUrl(normalized.url)
    const resourceKey = webResourceKey(canonical)
    const matched = matchSiteRule(normalized.url, rules)
    openLearningContent({
      kind: 'web',
      resourceKey,
      recordId: resourceKey,
      title: optStr(body.label, 'study.openWeb.label', { max: 200 }) || matched?.label || normalized.url.hostname,
      topic: optStr(body.topic, 'study.openWeb.topic', { max: 500 }),
      autoFullscreen: body.autoFullscreen !== false,
      plannedMs: plannedMsOf(body.plannedMs),
      source: 'manual',
      url: normalized.url.href,
      sourceUri: canonical
    })
  })

  ipcMain.handle(IPC_CHANNELS.study.resume, (_event, raw: unknown): void => {
    const recordId = str(raw, 'study.resume.recordId', { max: 120 })
    const sourceUri = getPlaySourceUri(recordId)
    assertExitSafety(getSettings().lockLevel)
    if (recordId.startsWith('local:')) {
      if (!sourceUri) throw new Error('找不到本地视频文件记录')
      const file = assertLocalMediaFile(sourceUri)
      if (file.resourceKey !== recordId) {
        throw new Error('文件已变化，请重新选择')
      }
      const token = issueMediaToken(file)
      openLearningContent({
        kind: 'local',
        resourceKey: file.resourceKey,
        recordId: file.resourceKey,
        title: file.title,
        autoFullscreen: getSettings().bili.autoFullscreen,
        mediaToken: token.token,
        sourceUri: file.realPath,
        source: 'resume'
      })
      return
    }
    if (recordId.startsWith('web:')) {
      if (!sourceUri) throw new Error('找不到学习网站地址')
      const normalized = normalizeLearningUrl(sourceUri)
      if (!normalized.ok) throw new Error(normalized.reason)
      const rules = getSettings().learning.sites.filter((rule) => rule.enabled)
      const verdict = judgeLearningUrl(normalized.url.href, rules)
      if (!verdict.allowed) throw new Error(verdict.reason)
      openLearningContent({
        kind: 'web',
        resourceKey: recordId,
        recordId,
        title: normalized.url.hostname,
        autoFullscreen: getSettings().bili.autoFullscreen,
        url: normalized.url.href,
        sourceUri: canonicalWebUrl(normalized.url),
        source: 'resume'
      })
      return
    }
    throw new Error('该记录不是本地视频或学习网站')
  })

  ipcMain.handle(IPC_CHANNELS.study.previewSite, (_event, raw: unknown) => {
    const body = safeRecord(raw)
    const text = str(body.text, 'study.previewSite.text', { max: 500 })
    const prefixes = Array.isArray(body.pathPrefixes)
      ? body.pathPrefixes.filter((item): item is string => typeof item === 'string').slice(0, 20)
      : []
    return draftSiteRuleFromText(text, prefixes, optStr(body.label, 'study.previewSite.label', { max: 80 }))
  })
}
