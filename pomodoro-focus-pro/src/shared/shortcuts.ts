/** 快捷键统一注册表共享类型（P1-6）。纯类型/常量/校验，无运行时依赖。 */

export type ShortcutScope = 'guard' | 'volume' | 'panel'
export type CustomizableShortcutId = 'volumeUp' | 'volumeDown' | 'overlayToggle' | 'closeVideo'
export type ShortcutId = CustomizableShortcutId | string

export interface HotkeysSettings {
  volumeUp: string
  volumeDown: string
  overlayToggle: string
  closeVideo: string
}

export const HOTKEY_DEFAULTS: HotkeysSettings = {
  volumeUp: 'CommandOrControl+Shift+Up',
  volumeDown: 'CommandOrControl+Shift+Down',
  overlayToggle: 'CommandOrControl+Shift+O',
  closeVideo: 'CommandOrControl+Shift+Q'
}

export interface ShortcutEntry {
  id: ShortcutId
  label: string
  accelerator: string
  scope: ShortcutScope
  customizable: boolean
  /** 当前是否已生效（已向系统注册成功且处于激活期） */
  ok: boolean
  reason?: string
}

export interface SetAcceleratorResult {
  ok: boolean
  error?: string
  /** true = 当前未激活，仅保存，下次激活时生效 */
  deferred?: boolean
  entries: ShortcutEntry[]
}

const MODIFIERS = new Set([
  'commandorcontrol',
  'command',
  'control',
  'ctrl',
  'alt',
  'option',
  'shift',
  'super',
  'meta'
])
const NAMED_KEYS = new Set([
  'up','down','left','right','space','tab','enter','escape','esc','backspace','delete','insert',
  'home','end','pageup','pagedown','plus','`','~','-','=','[',']','\\',';',"'",',','.','/'
])

/** Electron accelerator 格式校验：修饰键+主键，至少一个修饰键（F1-F12/单键拦截键除外由调用方把关） */
export function isValidAccelerator(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 60 || /[\u0000-\u001f\u007f]/.test(value)) return false
  const parts = value.split('+').map((p) => p.trim())
  if (parts.length < 1 || parts.some((p) => !p)) return false
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (mods.some((m) => !MODIFIERS.has(m.toLowerCase()))) return false
  if (/^f(\d|1[0-2])$/i.test(key)) return mods.length === 0 || true
  if (/^[a-z0-9]$/i.test(key)) return mods.length >= 1
  if (NAMED_KEYS.has(key.toLowerCase())) return mods.length >= 1
  return false
}
