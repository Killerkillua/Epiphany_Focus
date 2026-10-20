import { Notification } from 'electron'
import { getAppIcon } from './icon'
import { logger } from './logger'

/** 与 electron-builder.yml 的 appId 一致，供 Windows 通知身份使用 */
export const APP_USER_MODEL_ID = 'com.pomodoro.focuspro'

/**
 * 桌面通知。带上应用图标，并在系统不支持时直接跳过。
 * 未打包的 Windows 开发构建仍可能被系统丢掉通知（没有开始菜单快捷方式）。
 */
export function showAppNotification(title: string, body: string): void {
  try {
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return
    const icon = safeIcon()
    const notice = new Notification({
      title,
      body,
      silent: true,
      ...(icon ? { icon } : {})
    })
    notice.show()
  } catch (err) {
    logger.warn('notify', '桌面通知发送失败:', err instanceof Error ? err.message : err)
  }
}

function safeIcon(): Electron.NativeImage | undefined {
  try {
    return getAppIcon()
  } catch {
    return undefined
  }
}
