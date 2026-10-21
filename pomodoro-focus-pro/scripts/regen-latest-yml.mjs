#!/usr/bin/env node
/**
 * 签名后重算 latest.yml（P0-3 第二档 · SignPath）
 *
 * SignPath 在 CI 中对 NSIS 安装包签名会改变文件字节，原 latest.yml 里的
 * sha512/size 随即失效。若沿用签名前的 latest.yml 发布，electron-updater
 * 校验必然失败。本脚本以签名后的最终安装包为准重算 sha512 与 size。
 *
 * 用法：
 *   node scripts/regen-latest-yml.mjs <distDir>           # 重算并写回 latest.yml
 *   node scripts/regen-latest-yml.mjs <distDir> --check   # 仅校验，不一致退出码 1
 *
 * 仅支持 Windows latest.yml 的单文件形态（files 下只有一个安装包条目），
 * 与 electron-builder 当前 NSIS 配置一致；多文件形态直接报错，避免误改。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const distDir = process.argv[2]
const checkOnly = process.argv.includes('--check')

if (!distDir) {
  console.error('用法: node scripts/regen-latest-yml.mjs <distDir> [--check]')
  process.exit(2)
}

const ymlPath = join(distDir, 'latest.yml')
if (!existsSync(ymlPath)) {
  console.error(`未找到 ${ymlPath}，请先用 electron-builder --publish never 生成`)
  process.exit(1)
}

const original = readFileSync(ymlPath, 'utf8')

// 顶层 path: 即安装包文件名
const pathMatch = original.match(/^path:\s*(.+?)\s*$/m)
if (!pathMatch) {
  console.error('latest.yml 缺少顶层 path 字段，格式不符合预期')
  process.exit(1)
}
const installerName = basename(pathMatch[1].trim())
const installerPath = join(distDir, installerName)
if (!existsSync(installerPath)) {
  console.error(`latest.yml 指向的安装包不存在: ${installerPath}`)
  process.exit(1)
}

// files: 下应只有一个 sha512 条目（单文件 NSIS）
const shaLines = original.match(/^\s*sha512:\s*.+$/gm) ?? []
// 顶层 sha512 与 files[].sha512 合计应为 2 行（同一文件）
if (shaLines.length !== 2) {
  console.error(
    `latest.yml 的 sha512 行数为 ${shaLines.length}，预期 2（顶层 + files[0]）。多文件形态请勿用本脚本。`
  )
  process.exit(1)
}

const buf = readFileSync(installerPath)
const sha512 = createHash('sha512').update(buf).digest('base64')
const size = statSync(installerPath).size

let next = original
  .replace(/^(\s*)sha512:\s*.+$/gm, `$1sha512: ${sha512}`)
  .replace(/^(\s*)size:\s*\d+\s*$/m, `$1size: ${size}`)

if (!/^\s*size:\s*\d+\s*$/m.test(original)) {
  console.error('latest.yml 缺少 files[0].size 字段，格式不符合预期')
  process.exit(1)
}

if (checkOnly) {
  if (next !== original) {
    console.error(
      `latest.yml 与签名后安装包 ${installerName} 不一致（sha512/size 已失效），请先执行重算。`
    )
    process.exit(1)
  }
  console.log(`latest.yml 校验通过: ${installerName} sha512 与 size 一致`)
  process.exit(0)
}

if (next === original) {
  console.log(`latest.yml 无需更新: ${installerName} 的 sha512/size 已是最新`)
} else {
  writeFileSync(ymlPath, next, 'utf8')
  console.log(`latest.yml 已按签名后文件重算: ${installerName} size=${size}`)
  console.log(`sha512=${sha512}`)
}
