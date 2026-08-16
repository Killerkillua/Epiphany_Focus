import type { LockLevel } from '../../shared/settings'

/**
 * 锁定强度分级（方案 2.5）。
 * L0 轻量：置顶 + 提醒（全部可绕过，首次引导默认）
 * L1 标准：全屏遮罩 + 全局快捷键拦截 + 任务栏隐藏 + 分心应用强关 + 前台拉回
 * L2 强化：L1 + 守护进程每 2s 自检拉起 + 关闭任务管理器 + 重启恢复会话
 * L3 内核级：不做（需 EV 签名/公证，成本极高，远期评估）
 */

export interface LevelCapabilities {
  /** 窗口置顶 */
  alwaysOnTop: boolean
  /** 全屏遮罩（setFullScreen + 不可关闭/缩放） */
  fullscreenOverlay: boolean
  /** globalShortcut 拦截（F11/Ctrl+T/Ctrl+W/Ctrl+R/F5 空处理） */
  globalShortcuts: boolean
  /** 任务栏隐藏（全屏 + skipTaskbar） */
  hideTaskbar: boolean
  /** 分心应用强关（taskkill 黑名单） */
  killDistractions: boolean
  /** 前台窗口检测拉回（失焦自动拉回本窗口） */
  pullBackForeground: boolean
  /** 关闭任务管理器（taskkill） */
  killTaskmgr: boolean
  /** 守护进程自检拉起 + 重启恢复 */
  guardian: boolean
}

export const LEVEL_CAPS: Record<LockLevel, LevelCapabilities> = {
  L0: {
    alwaysOnTop: true,
    fullscreenOverlay: false,
    globalShortcuts: false,
    hideTaskbar: false,
    killDistractions: false,
    pullBackForeground: false,
    killTaskmgr: false,
    guardian: false
  },
  L1: {
    alwaysOnTop: true,
    fullscreenOverlay: true,
    globalShortcuts: true,
    hideTaskbar: true,
    killDistractions: true,
    pullBackForeground: true,
    killTaskmgr: false,
    guardian: false
  },
  L2: {
    alwaysOnTop: true,
    fullscreenOverlay: true,
    globalShortcuts: true,
    hideTaskbar: true,
    killDistractions: true,
    pullBackForeground: true,
    killTaskmgr: true,
    guardian: true
  }
}

/** 是否为强制级别（L0 可全绕过） */
export function isEnforcedLevel(level: LockLevel): boolean {
  return level !== 'L0'
}

export const LEVEL_LABEL: Record<LockLevel, string> = {
  L0: 'L0 轻量（置顶提醒，可绕过）',
  L1: 'L1 标准（全屏遮罩 + 快捷键拦截 + 分心强关）',
  L2: 'L2 强化（+ 守护进程自检拉起 + 重启恢复）'
}
