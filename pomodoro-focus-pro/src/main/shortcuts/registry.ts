import { BrowserWindow, globalShortcut, ipcMain } from 'electron'
import { logger } from '../logger'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
import {
  HOTKEY_DEFAULTS,
  isValidAccelerator,
  type CustomizableShortcutId,
  type SetAcceleratorResult,
  type ShortcutEntry,
  type ShortcutScope
} from '../../shared/shortcuts'
import { getSettings, setSettings } from '../storage/settings'

/**
 * 快捷键统一注册表（P1-6）：收敛 shortcutGuard / audio / biliWindow 三处注册点。
 * register() 返回 false（被占用）不再被吞：记 logger.warn 并存入注册表供 UI 高亮。
 */
export interface ShortcutBackend {
  register(accelerator: string, cb: () => void): boolean
  unregister(accelerator: string): void
}

const electronBackend: ShortcutBackend = {
  register: (a, cb) => globalShortcut.register(a, cb),
  unregister: (a) => globalShortcut.unregister(a)
}
let backend: ShortcutBackend = electronBackend
/** 测试注入 */
export function __setShortcutBackend(b: ShortcutBackend | null): void {
  backend = b ?? electronBackend
}

interface Internal extends ShortcutEntry {
  callback?: () => void
  active: boolean
}
const entries = new Map<string, Internal>()
const listeners = new Set<() => void>()

export function onShortcutStatusChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function notify(): void {
  for (const fn of listeners) { try { fn() } catch { /* ignore */ } }
}

export function getShortcutStatus(): ShortcutEntry[] {
  return [...entries.values()].map(({ callback: _c, active: _a, ...e }) => ({ ...e }))
}

const OCCUPIED = '已被系统或其他应用占用'

function doRegister(e: Internal): boolean {
  if (!e.callback) return false
  let ok = false
  try { ok = backend.register(e.accelerator, e.callback) } catch { ok = false }
  e.active = true
  e.ok = ok
  e.reason = ok ? undefined : OCCUPIED
  if (!ok) logger.warn('shortcuts', `快捷键注册失败（${OCCUPIED}）: ${e.accelerator}（${e.label}）`)
  return ok
}

export function registerShortcut(def: {
  id: string; label: string; accelerator: string; scope: ShortcutScope; customizable: boolean; callback: () => void
}): boolean {
  const prev = entries.get(def.id)
  const e: Internal = { ...def, ok: false, active: true, reason: prev?.reason }
  entries.set(def.id, e)
  const ok = doRegister(e)
  notify()
  return ok
}

export function unregisterShortcut(id: string): void {
  const e = entries.get(id)
  if (!e?.active) return
  try { backend.unregister(e.accelerator) } catch { /* ignore */ }
  e.active = false
  e.ok = false
  e.reason = '当前未激活'
  notify()
}

export function unregisterShortcutsByScope(scope: ShortcutScope): void {
  for (const e of entries.values()) if (e.scope === scope) unregisterShortcut(e.id)
}

/** 改键：先注销旧键再注册新键，失败回滚旧键。未激活项仅更新键位（deferred）。 */
export function setShortcutAccelerator(id: string, accelerator: string): SetAcceleratorResult {
  const fail = (error: string): SetAcceleratorResult => ({ ok: false, error, entries: getShortcutStatus() })
  const e = entries.get(id)
  if (!e) return fail(`未知快捷键: ${id}`)
  if (!e.customizable) return fail(`「${e.label}」为系统拦截键，不可修改`)
  if (!isValidAccelerator(accelerator)) return fail(`快捷键格式不正确: ${accelerator}`)
  const dup = [...entries.values()].find(
    (o) => o.id !== id && o.accelerator.toLowerCase() === accelerator.toLowerCase()
  )
  if (dup) return fail(`「${accelerator}」已被「${dup.label}」使用`)
  if (accelerator === e.accelerator) return { ok: true, deferred: !e.active, entries: getShortcutStatus() }

  const old = e.accelerator
  if (!e.active) {
    e.accelerator = accelerator
    e.reason = '当前未激活，进入学习会话/生效时机后启用'
    notify()
    return { ok: true, deferred: true, entries: getShortcutStatus() }
  }
  try { backend.unregister(old) } catch { /* ignore */ }
  e.accelerator = accelerator
  if (doRegister(e)) { notify(); return { ok: true, entries: getShortcutStatus() } }
  // 回滚旧键
  const failReason = e.reason
  try { backend.unregister(accelerator) } catch { /* ignore */ }
  e.accelerator = old
  const rolledBack = doRegister(e)
  notify()
  return fail(
    `「${e.label}」的新快捷键 ${accelerator} ${OCCUPIED}${rolledBack ? '，已恢复原快捷键' : '，且原快捷键恢复失败'}${failReason ? '' : ''}`
  )
}

const LABELS: Record<CustomizableShortcutId, string> = {
  volumeUp: '音量 +', volumeDown: '音量 -', overlayToggle: '面板显隐', closeVideo: '关闭视频'
}
const CUSTOMIZABLE = Object.keys(LABELS) as CustomizableShortcutId[]

/** 确保可自定义项在注册表中有占位（面板键会话外未注册时 UI 仍可展示/改键） */
export function ensureCustomizableEntries(): void {
  const hk = { ...HOTKEY_DEFAULTS, ...getSettings().hotkeys }
  for (const id of CUSTOMIZABLE) {
    if (!entries.has(id)) {
      entries.set(id, {
        id, label: LABELS[id], accelerator: hk[id],
        scope: id.startsWith('volume') ? 'volume' : 'panel',
        customizable: true, ok: false, active: false, reason: '当前未激活'
      })
    }
  }
}

function persist(id: CustomizableShortcutId, accelerator: string): void {
  setSettings({ hotkeys: { ...getSettings().hotkeys, [id]: accelerator } })
}

export function registerShortcutsIpc(): void {
  ensureCustomizableEntries()
  onShortcutStatusChanged(() => {
    const payload = getShortcutStatus()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.shortcuts.statusChanged, payload)
    }
  })
  ipcMain.handle(IPC_CHANNELS.shortcuts.getStatus, (): ShortcutEntry[] => {
    ensureCustomizableEntries()
    return getShortcutStatus()
  })
  ipcMain.handle(
    IPC_CHANNELS.shortcuts.setAccelerator,
    (_e, id: unknown, accelerator: unknown): SetAcceleratorResult => {
      ensureCustomizableEntries()
      if (typeof id !== 'string' || !CUSTOMIZABLE.includes(id as CustomizableShortcutId)) {
        return { ok: false, error: '仅可修改音量/面板/关闭视频快捷键', entries: getShortcutStatus() }
      }
      const res = setShortcutAccelerator(id, typeof accelerator === 'string' ? accelerator : '')
      if (res.ok) persist(id as CustomizableShortcutId, accelerator as string)
      return res
    }
  )
  ipcMain.handle(IPC_CHANNELS.shortcuts.resetDefaults, (): SetAcceleratorResult => {
    ensureCustomizableEntries()
    let last: SetAcceleratorResult = { ok: true, entries: getShortcutStatus() }
    for (const id of CUSTOMIZABLE) {
      last = setShortcutAccelerator(id, HOTKEY_DEFAULTS[id])
      if (!last.ok) return last
      persist(id, HOTKEY_DEFAULTS[id])
    }
    return { ok: true, entries: getShortcutStatus() }
  })
}
