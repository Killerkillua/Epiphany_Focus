import cp from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bin = require('app-builder-bin').appBuilderPath

const root = path.resolve('..')
const srcIcon = path.join(root, 'Image', 'Icon.png')
const buildDir = path.resolve('build')
const resourcesDir = path.resolve('resources')
const rendererPublicDir = path.resolve('src/renderer/public')
const rendererAssetsDir = path.resolve('src/renderer/src/assets')
const landingDir = path.join(root, 'landing')

if (!fs.existsSync(srcIcon)) {
  console.error('Source icon not found:', srcIcon)
  process.exit(1)
}

fs.mkdirSync(buildDir, { recursive: true })
fs.mkdirSync(resourcesDir, { recursive: true })
fs.mkdirSync(rendererPublicDir, { recursive: true })
fs.mkdirSync(rendererAssetsDir, { recursive: true })
fs.mkdirSync(landingDir, { recursive: true })

// 1. 复制原图 png 到相应位置
fs.copyFileSync(srcIcon, path.join(buildDir, 'icon.png'))
fs.copyFileSync(srcIcon, path.join(resourcesDir, 'icon.png'))
fs.copyFileSync(srcIcon, path.join(rendererPublicDir, 'icon.png'))
fs.copyFileSync(srcIcon, path.join(rendererAssetsDir, 'icon.png'))
fs.copyFileSync(srcIcon, path.join(landingDir, 'icon.png'))
console.log('Copied icon.png to build/, resources/, renderer/public/, renderer/src/assets/, landing/')

// 2. 使用 app-builder-bin 生成 Windows .ico
const icoRes = cp.spawnSync(bin, ['icon', '--format=ico', `--input=${srcIcon}`, `--out=${buildDir}`], { encoding: 'utf8' })
console.log('ICO result:', icoRes.status, icoRes.stdout || '', icoRes.stderr || '')

// 3. 使用 app-builder-bin 生成 macOS .icns
const icnsRes = cp.spawnSync(bin, ['icon', '--format=icns', `--input=${srcIcon}`, `--out=${buildDir}`], { encoding: 'utf8' })
console.log('ICNS result:', icnsRes.status, icnsRes.stdout || '', icnsRes.stderr || '')

// 4. 将生成的 icon.ico 也备份到 resources/ 与 renderer/public/
const generatedIco = path.join(buildDir, 'icon.ico')
if (fs.existsSync(generatedIco)) {
  fs.copyFileSync(generatedIco, path.join(resourcesDir, 'icon.ico'))
  fs.copyFileSync(generatedIco, path.join(rendererPublicDir, 'favicon.ico'))
  fs.copyFileSync(generatedIco, path.join(landingDir, 'favicon.ico'))
  console.log('Copied icon.ico / favicon.ico to resources/, renderer/public/, landing/')
}
