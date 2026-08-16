import { globalShortcut } from 'electron'

/**
 * 全局快捷键拦截（方案 2.5 L1+，防绕过矩阵）：
 * F11 / Ctrl+T / Ctrl+W / Ctrl+R / F5 注册为空处理（消费掉快捷键）。
 * Esc 不在此注册：需留给渲染层"连按 5 次 Esc"紧急退出检测。
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
  for (const acc of SHORTCUT_KEYS) {
    try {
      // 空处理：拦截系统/浏览器默认行为
      globalShortcut.register(acc, () => undefined)
    } catch {
      // 快捷键被其他程序占用时忽略，不阻断会话
    }
  }
  registered = true
}

export function unregisterShortcutGuard(): void {
  if (!registered) return
  for (const acc of SHORTCUT_KEYS) {
    try {
      globalShortcut.unregister(acc)
    } catch {
      // 忽略
    }
  }
  registered = false
}
