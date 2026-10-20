import {
  registerShortcut,
  unregisterShortcut
} from '../shortcuts/registry'

/**
 * 全局快捷键拦截（方案 2.5 L1+，防绕过矩阵）：
 * F11 / Ctrl+T / Ctrl+W / Ctrl+R / F5 注册为空处理（消费掉快捷键）。
 * Esc 不在此注册：需留给渲染层"连按 5 次 Esc"紧急退出检测。
 * 固定拦截键，不可自定义（P1-6）；注册成败经统一注册表上报。
 */

const SHORTCUT_KEYS = [
  'F11',
  'CommandOrControl+T',
  'CommandOrControl+W',
  'CommandOrControl+R',
  'F5'
] as const

let registered = false

export function registerShortcutGuard(): void {
  if (registered) return
  registered = true
  for (const acc of SHORTCUT_KEYS) {
    registerShortcut({
      id: `guard:${acc}`,
      label: `拦截 ${acc}`,
      accelerator: acc,
      scope: 'guard',
      customizable: false,
      callback: () => undefined
    })
  }
}

export function unregisterShortcutGuard(): void {
  if (!registered) return
  registered = false
  for (const acc of SHORTCUT_KEYS) unregisterShortcut(`guard:${acc}`)
}
