import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { getAppIcon } from './icon'
import { logger } from './logger'
import { showAppNotification } from './notify'
import type { EnforcementHandle } from './enforcement'
import type { TimerSnapshot } from '../shared/types'

type TrayVisual = 'idle' | 'running' | 'paused'

export interface TrayControls {
  showWindow: () => void
  requestQuit: () => void
}

/**
 * 系统托盘。关闭主窗口时由主进程隐藏到这里，进程继续跑。
 * 图标只在空闲 / 进行中 / 暂停之间切换；倒计时每秒只改 Tooltip（macOS 再改标题）。
 */
export function installAppTray(
  enforcement: EnforcementHandle,
  controls: TrayControls
): { destroy: () => void } {
  const icons = loadStatusIcons()
  const tray = new Tray(icons.idle)
  tray.setToolTip('静界专注')
  let visual: TrayVisual = 'idle'
  let menuKey = ''

  const apply = (snap: TimerSnapshot): void => {
    const view = describeTimer(snap)
    tray.setToolTip(view.tooltip)
    if (process.platform === 'darwin') tray.setTitle(view.title)
    if (view.visual !== visual) {
      visual = view.visual
      tray.setImage(icons[view.visual])
    }
    const key = menuSignature(snap, enforcement)
    if (key !== menuKey) {
      menuKey = key
      tray.setContextMenu(buildMenu(enforcement, controls, snap))
    }
  }

  const openMenu = (): void => {
    const snap = enforcement.getTimerSnapshot()
    menuKey = menuSignature(snap, enforcement)
    tray.setContextMenu(buildMenu(enforcement, controls, snap))
  }

  tray.on('click', () => controls.showWindow())
  tray.on('right-click', openMenu)
  apply(enforcement.getTimerSnapshot())

  const unsubscribe = enforcement.onTimerChanged(apply)

  return {
    destroy: () => {
      unsubscribe()
      tray.destroy()
    }
  }
}

function menuSignature(snap: TimerSnapshot, enforcement: EnforcementHandle): string {
  return `${snap.status}|${enforcement.isQuitBlocked()}|${enforcement.getFocusMinutes()}`
}

function buildMenu(
  enforcement: EnforcementHandle,
  controls: TrayControls,
  snap: TimerSnapshot
): Electron.Menu {
  const minutes = enforcement.getFocusMinutes()
  const quitBlocked = enforcement.isQuitBlocked()
  const busy = snap.status === 'running' || snap.status === 'paused' || snap.status === 'finished'
  const template: MenuItemConstructorOptions[] = [
    { label: '显示主窗口', click: () => controls.showWindow() },
    { type: 'separator' },
    {
      label: `开始 ${minutes} 分钟专注`,
      enabled: !busy && !quitBlocked,
      click: () => {
        try {
          enforcement.startDefaultFocus()
        } catch (err) {
          const message = err instanceof Error ? err.message : '无法开始专注'
          logger.warn('tray', message)
          showAppNotification('无法开始专注', message)
          controls.showWindow()
        }
      }
    },
    {
      label: snap.status === 'paused' ? '继续' : '暂停',
      enabled: snap.status === 'running' || snap.status === 'paused',
      click: () => {
        if (snap.status === 'paused') enforcement.resumeTimer()
        else enforcement.pauseTimer()
      }
    },
    { type: 'separator' },
    {
      label: quitBlocked ? '退出（强制专注中不可用）' : '退出',
      enabled: !quitBlocked,
      click: () => controls.requestQuit()
    }
  ]
  return Menu.buildFromTemplate(template)
}

function describeTimer(snap: TimerSnapshot): {
  visual: TrayVisual
  tooltip: string
  title: string
} {
  if (snap.status === 'running' || snap.status === 'paused') {
    const clock = formatClock(
      snap.mode === 'countup' ? snap.elapsedMs : snap.remainingMs,
      snap.mode !== 'countup'
    )
    const prefix =
      snap.status === 'paused' ? '已暂停' : snap.mode === 'countup' ? '计时中' : '专注中'
    const label = snap.mode === 'countup' ? `已进行 ${clock}` : `剩余 ${clock}`
    return {
      visual: snap.status === 'paused' ? 'paused' : 'running',
      tooltip: `${prefix} · ${label}`,
      title: clock
    }
  }
  if (snap.status === 'finished') {
    return { visual: 'idle', tooltip: '静界专注 · 本轮已结束', title: '' }
  }
  return { visual: 'idle', tooltip: '静界专注', title: '' }
}

/** 倒计时向上取整，正序向下取整，避免最后一秒提前显示 0:00 */
function formatClock(ms: number, ceil: boolean): string {
  const total = Math.max(0, ceil ? Math.ceil(ms / 1000) : Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function loadStatusIcons(): Record<TrayVisual, Electron.NativeImage> {
  const size = process.platform === 'darwin' ? 22 : 16
  try {
    const base = getAppIcon()?.resize({ width: size, height: size, quality: 'best' })
    if (base && !base.isEmpty()) {
      return {
        idle: base,
        running: tintBitmap(base, 1.2) ?? base,
        paused: tintBitmap(base, 0.45) ?? base
      }
    }
  } catch (err) {
    logger.warn(
      'tray',
      '读取应用图标失败，使用内置托盘图标:',
      err instanceof Error ? err.message : err
    )
  }
  return {
    idle: circleIcon(size, 138, 64, 56),
    running: circleIcon(size, 255, 107, 74),
    paused: circleIcon(size, 154, 163, 175)
  }
}

function tintBitmap(img: Electron.NativeImage, factor: number): Electron.NativeImage | null {
  try {
    const scale = img.getScaleFactors()[0] || 1
    const width = Math.max(1, Math.round(img.getSize().width * scale))
    const height = Math.max(1, Math.round(img.getSize().height * scale))
    const buf = Buffer.from(img.toBitmap())
    if (buf.length < width * height * 4) return null
    for (let i = 0; i + 3 < width * height * 4; i += 4) {
      buf[i] = clamp(buf[i] * factor)
      buf[i + 1] = clamp(buf[i + 1] * factor)
      buf[i + 2] = clamp(buf[i + 2] * factor)
    }
    return nativeImage.createFromBitmap(buf, { width, height, scaleFactor: scale })
  } catch {
    return null
  }
}

function circleIcon(size: number, r: number, g: number, b: number): Electron.NativeImage {
  const buf = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size * 0.42
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center
      const dy = y - center
      if (dx * dx + dy * dy > radius * radius) continue
      const i = (y * size + x) * 4
      buf[i] = b
      buf[i + 1] = g
      buf[i + 2] = r
      buf[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}
