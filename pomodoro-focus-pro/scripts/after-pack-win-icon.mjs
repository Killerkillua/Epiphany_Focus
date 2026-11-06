/**
 * 本机非管理员无法解压 winCodeSign（darwin 符号链接），故 win.signAndEditExecutable
 * 必须为 false。此 hook 用纯 JS 的 resedit 写入图标，不依赖 winCodeSign / rcedit。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ResEdit from 'resedit'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = path.join(context.appOutDir, exeName)
  const iconPath = path.join(root, 'build', 'icon.ico')

  if (!fs.existsSync(exePath)) {
    console.warn('[after-pack-win-icon] exe not found:', exePath)
    return
  }
  if (!fs.existsSync(iconPath)) {
    console.warn('[after-pack-win-icon] icon not found:', iconPath)
    return
  }

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath))
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)

  const groupId = iconGroups[0]?.id ?? 1
  const lang = iconGroups[0]?.lang ?? 1033

  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groupId,
    lang,
    iconFile.icons.map((item) => item.data)
  )

  res.outputResource(exe)
  const outPath = `${exePath}.icon-tmp`
  fs.writeFileSync(outPath, Buffer.from(exe.generate()))
  fs.renameSync(outPath, exePath)
  console.log('[after-pack-win-icon] set icon on', exeName, `(group=${groupId}, lang=${lang})`)
}
