import { app, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * 获取应用主图标（NativeImage）
 * 依次尝试开发环境路径、安装包解包路径、resources 路径与 appPath 兜底。
 */
export function getAppIcon(): Electron.NativeImage | undefined {
  const candidates = [
    join(__dirname, '../../resources/icon.png'),
    join(process.resourcesPath, 'resources/icon.png'),
    join(process.resourcesPath, 'app.asar.unpacked/resources/icon.png'),
    join(app.getAppPath(), 'resources/icon.png')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const img = nativeImage.createFromPath(candidate)
      if (!img.isEmpty()) {
        return img
      }
    }
  }
  return undefined
}
