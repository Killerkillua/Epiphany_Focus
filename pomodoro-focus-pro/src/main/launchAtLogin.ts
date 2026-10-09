import { app } from 'electron'

/**
 * 把「开机自启」同步到系统登录项。
 * 开发模式不写登录项，避免把 electron.exe 注册成开机启动。
 * openAsHidden：开机后只留托盘，不弹出主窗口。
 */
export function applyLaunchAtLogin(openAtLogin: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin,
    openAsHidden: true
  })
}

/** 本次启动是否由「开机隐藏」登录项拉起 */
export function wasOpenedAsHidden(): boolean {
  if (!app.isPackaged) return false
  try {
    return app.getLoginItemSettings().wasOpenedAsHidden === true
  } catch {
    return false
  }
}
