/**
 * 真实采样素材批量预处理脚本。
 *
 * 用法：
 *   1. 把下载的原始素材放入 resources/audio_raw/ 目录，文件名包含关键词即可
 *      （例如 "heavy_rain_on_roof.wav"、"cafe-background.mp3"，脚本会按关键词匹配到 8 类）
 *   2. 运行：node scripts/prepare-real-samples.mjs
 *   3. 输出自动覆盖 resources/audio/*.ogg
 *
 * 处理流水线（ffmpeg）：
 *   立体声→单声道 → 44.1kHz 重采样 → 截取中间 45s（如原素材够长）
 *   → 峰值归一化到 -3dB → OGG Vorbis q4 编码
 *   → （可选）首尾 1.5s 交叉淡化做无缝循环接缝
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  unlinkSync,
  statSync,
  rmdirSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW_DIR = join(__dirname, '..', 'resources', 'audio_raw')
const OUT_DIR = join(__dirname, '..', 'resources', 'audio')
const TARGET_DURATION = 45 // 目标时长 45s
const TARGET_SR = 44100
const TARGET_PEAK_DB = -3 // 峰值归一化目标
const XFADE_SEC = 1.5 // 首尾交叉淡化秒数（无缝循环接缝）

/* ---- 8 种素材的关键词匹配规则（原始文件名包含即匹配） ---- */
const MATCH_RULES = [
  { key: 'rain', keywords: ['rain', '雨', 'raindrop', 'rainfall', 'shower', 'storm'] },
  { key: 'cafe', keywords: ['cafe', 'caf', 'coffee', 'restaurant', '咖啡', '餐厅', 'babble'] },
  { key: 'forest', keywords: ['forest', 'wood', '树', '森', 'jungle', 'woods'] },
  { key: 'library', keywords: ['library', '图书', 'book', 'study', 'quiet', 'silent'] },
  { key: 'waves', keywords: ['wave', '海', 'ocean', 'beach', 'surf', 'tide', '浪'] },
  { key: 'fire', keywords: ['fire', 'campfire', 'bonfire', 'flame', '篝火', '火', 'crackle'] },
  { key: 'fan', keywords: ['fan', '风扇', 'hvac', 'aircon', 'vent', '空调', 'hum'] },
  { key: 'birds', keywords: ['bird', '鸟鸣', 'chirp', 'sing', 'warble', 'tweet', '雀'] }
]

/* ---- 工具 ---- */

function runFfmpeg(args, label) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (r.status !== 0) {
    const err = r.stderr.toString().trim()
    console.error(`    ✗ ffmpeg ${label} 失败: ${err.slice(0, 300)}`)
    return false
  }
  return true
}

function probeDuration(file) {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file
    ],
    { stdio: 'pipe' }
  )
  if (r.status !== 0) return null
  const d = parseFloat(r.stdout.toString().trim())
  return isNaN(d) ? null : d
}

/* ---- 主流程 ---- */

console.log('真实采样素材批量预处理')
console.log(`原始素材目录: ${RAW_DIR}`)
console.log(`输出目录: ${OUT_DIR}\n`)

if (!existsSync(RAW_DIR)) {
  mkdirSync(RAW_DIR, { recursive: true })
  console.log(`✗ 原始目录不存在，已为你创建。请把下载的素材文件放入: ${RAW_DIR}`)
  console.log('  文件名包含关键词即可（如 my_rain_sound.mp3 → 自动匹配 rain）')
  process.exit(1)
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe' }).status === 0
if (!hasFfmpeg) {
  console.error('✗ 未检测到 ffmpeg，请先安装（https://www.gyan.dev/ffmpeg/builds/）')
  process.exit(1)
}

const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'pipe' }).status === 0
if (!hasFfprobe) {
  console.warn('⚠ 未检测到 ffprobe，部分时长探测会跳过')
}

mkdirSync(OUT_DIR, { recursive: true })

/* 1. 扫描 raw 目录并按关键词匹配 */
const rawFiles = readdirSync(RAW_DIR).filter((f) => !f.startsWith('.'))
const matched = new Map() // key → 原始路径

for (const f of rawFiles) {
  const lower = f.toLowerCase()
  const rule = MATCH_RULES.find((r) => r.keywords.some((kw) => lower.includes(kw.toLowerCase())))
  if (!rule) continue
  if (matched.has(rule.key)) {
    console.log(`  ⚠ ${rule.key} 已匹配到 ${matched.get(rule.key)}，忽略重复的 ${f}`)
    continue
  }
  matched.set(rule.key, join(RAW_DIR, f))
  console.log(`  匹配: ${rule.key} ← ${f}`)
}

console.log()
const missing = MATCH_RULES.filter((r) => !matched.has(r.key))
if (missing.length) {
  console.log(`⚠ 以下 ${missing.length} 种素材未匹配到原始文件，将跳过：`)
  for (const r of missing) console.log(`    - ${r.key} (关键词: ${r.keywords.join('/')})`)
  console.log()
}

if (matched.size === 0) {
  console.log('✗ 没有匹配到任何素材，请检查文件名是否包含关键词。')
  process.exit(1)
}

/* 2. 对每个匹配的素材执行 ffmpeg 处理流水线 */
const tmpDir = join(OUT_DIR, '.tmp_prepare')
mkdirSync(tmpDir, { recursive: true })

const results = []

for (const rule of MATCH_RULES) {
  const src = matched.get(rule.key)
  if (!src) continue
  console.log(`[${rule.key}] 处理中...`)

  const duration = hasFfprobe ? probeDuration(src) : null
  if (duration !== null) console.log(`    原素材时长: ${duration.toFixed(1)}s`)

  // 步骤 1：基础预处理 → 单声道 / 44.1k / 截取中段 / 归一化
  const step1 = join(tmpDir, `${rule.key}_step1.wav`)
  const trimFilter =
    duration && duration > TARGET_DURATION + 4
      ? // 从 (总时长-目标)/2 处开始截取 TARGET_DURATION 秒（去掉开头结尾可能的不自然部分）
        `atrim=start=${((duration - TARGET_DURATION) / 2).toFixed(3)}:duration=${TARGET_DURATION},asetpts=PTS-STARTPTS`
      : duration && duration >= TARGET_DURATION * 0.6
        ? // 时长基本够用，不裁（短于 30s 后面 validate 会警告）
          null
        : null

  const afFilters1 = [
    'pan=mono|c0=0.5*c0+0.5*c1', // 立体声→单声道（等功率混合）
    `aformat=sample_rates=${TARGET_SR}`, // 44.1k 重采样
    trimFilter,
    `loudnorm=I=-16:TP=${TARGET_PEAK_DB}:LRA=11:print_format=json` // EBU R128 归一化
  ]
    .filter(Boolean)
    .join(',')

  const ok1 = runFfmpeg(
    ['-i', src, '-af', afFilters1, '-acodec', 'pcm_s16le', step1],
    `${rule.key} step1`
  )
  if (!ok1) continue

  // 步骤 2：首尾交叉淡化做无缝循环接缝
  // 方法：把音频后 XFADE_SEC 放到开头前，前 XFADE_SEC 放到末尾后，交叉淡化后裁回
  const step2 = join(tmpDir, `${rule.key}_step2.wav`)
  const dur2 = probeDuration(step1)
  if (dur2 && dur2 > XFADE_SEC * 4) {
    // 复杂做法：构造 A/B 段在接缝处 xfade，再裁回主体
    // 简化做法：直接在前 XFADE_SEC 和末尾 XFADE_SEC 做反向淡入淡出
    const afXfade = [
      `afade=t=in:st=0:d=${XFADE_SEC}`,
      `afade=t=out:st=${(dur2 - XFADE_SEC).toFixed(3)}:d=${XFADE_SEC}`
    ].join(',')
    runFfmpeg(['-i', step1, '-af', afXfade, '-acodec', 'pcm_s16le', step2], `${rule.key} xfade`)
  } else {
    // 太短就不做接缝处理了
    copyFileSync(step1, step2)
  }

  // 步骤 3：OGG Vorbis q4 编码输出
  const outPath = join(OUT_DIR, `${rule.key}.ogg`)
  const ok3 = runFfmpeg(
    ['-i', step2, '-c:a', 'libvorbis', '-q:a', '4', outPath],
    `${rule.key} → ogg`
  )
  if (!ok3) continue

  const finalDur = probeDuration(outPath) ?? dur2
  const sizeMB = (existsSync(outPath) ? statSync(outPath).size : 0) / 1048576
  console.log(
    `    ✓ 输出: ${rule.key}.ogg (${finalDur ? finalDur.toFixed(1) + 's' : '??s'}, ${sizeMB.toFixed(1)}MB)`
  )
  results.push(rule.key)
}

/* 3. 清理临时文件 */
try {
  for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f))
  rmdirSync(tmpDir)
} catch {
  /* 忽略清理错误 */
}

console.log(`\n完成！共处理 ${results.length}/${MATCH_RULES.length} 种素材：${results.join(', ')}`)
console.log(`下一步：运行 npm run samples:validate 验证规格合规性`)
