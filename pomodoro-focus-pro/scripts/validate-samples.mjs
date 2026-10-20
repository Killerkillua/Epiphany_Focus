/**
 * 白噪音采样素材规格验证脚本（方案 2.8 §3 落地设计）。
 *
 * 校验 resources/audio/ 下素材是否合规：
 * - 文件存在（.ogg 优先，.wav 兜底）
 * - 时长 30–60s
 * - 文件大小 ≤5MB
 * - 峰值 ≤ -3dB
 *
 * 用法：node scripts/validate-samples.mjs
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'resources', 'audio')

const SPECS = [
  { key: 'rain', base: 'rain' },
  { key: 'cafe', base: 'cafe' },
  { key: 'forest', base: 'forest' },
  { key: 'library', base: 'library' },
  { key: 'waves', base: 'waves' },
  { key: 'fire', base: 'fire' },
  { key: 'fan', base: 'fan' },
  { key: 'birds', base: 'birds' }
]

/** 解析 WAV 头获取时长和峰值 */
function parseWav(filePath) {
  const buf = readFileSync(filePath)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效 WAV 文件')
  }
  const sampleRate = buf.readUInt32LE(24)
  const bitsPerSample = buf.readUInt16LE(34)
  const channels = buf.readUInt16LE(22)
  // 找 data chunk
  let offset = 36
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') {
      const dataStart = offset + 8
      const numSamples = size / (bitsPerSample / 8) / channels
      const duration = numSamples / sampleRate
      // 计算峰值
      let peak = 0
      for (let i = dataStart; i < dataStart + size; i += 2) {
        const s = Math.abs(buf.readInt16LE(i) / 32768)
        if (s > peak) peak = s
      }
      return { duration, peak, sampleRate, bitsPerSample, channels }
    }
    offset += 8 + size
  }
  throw new Error('WAV 中未找到 data chunk')
}

/** 用 ffmpeg 探测音频时长（支持 MP3/OGG） */
function probeAudioDuration(filePath) {
  const result = spawnSync('ffmpeg', ['-i', filePath, '-f', 'null', '-'], {
    stdio: 'pipe'
  })
  const output = result.stderr.toString()
  const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
  if (!durMatch) return null
  const hours = parseInt(durMatch[1], 10)
  const mins = parseInt(durMatch[2], 10)
  const secs = parseInt(durMatch[3], 10)
  const frac = parseInt(durMatch[4], 10) / 100
  return hours * 3600 + mins * 60 + secs + frac
}

/** 用 ffmpeg 探测文件峰值 */
function probePeak(filePath) {
  const result = spawnSync(
    'ffmpeg',
    ['-i', filePath, '-af', 'volumedetect', '-vn', '-sn', '-dn', '-f', 'null', '-'],
    { stdio: 'pipe' }
  )
  const output = result.stderr.toString()
  const match = output.match(/max_volume:\s*([-\d.]+)\s*dB/)
  if (match) return parseFloat(match[1])
  return null
}

console.log('白噪音采样素材规格验证')
console.log(`目录: ${OUT}\n`)

let totalErrors = 0
let totalWarnings = 0

for (const spec of SPECS) {
  const mp3Path = join(OUT, `${spec.base}.mp3`)
  const oggPath = join(OUT, `${spec.base}.ogg`)
  const wavPath = join(OUT, `${spec.base}.wav`)
  const actualPath = existsSync(mp3Path)
    ? mp3Path
    : existsSync(oggPath)
      ? oggPath
      : existsSync(wavPath)
        ? wavPath
        : null
  const ext = actualPath ? actualPath.split('.').pop() : ''

  if (!actualPath) {
    console.log(`✗ ${spec.key}: 文件缺失 (${spec.base}.mp3 / ${spec.base}.ogg / ${spec.base}.wav)`)
    totalErrors++
    continue
  }

  const stat = statSync(actualPath)
  const sizeMB = stat.size / (1024 * 1024)
  const errors = []

  // 文件大小检查
  if (sizeMB > 5) errors.push(`文件过大: ${sizeMB.toFixed(1)}MB > 5MB`)

  // 时长检查
  let duration = null
  let peak = null
  if (ext === 'mp3' || ext === 'ogg') {
    duration = probeAudioDuration(actualPath)
    if (duration === null) {
      errors.push(`无法探测 ${ext.toUpperCase()} 时长（需要 ffmpeg）`)
      totalWarnings++
    }
  } else {
    try {
      const wavInfo = parseWav(actualPath)
      duration = wavInfo.duration
      peak = wavInfo.peak
      if (wavInfo.sampleRate !== 44100) errors.push(`采样率: ${wavInfo.sampleRate}Hz ≠ 44100Hz`)
      if (wavInfo.bitsPerSample !== 16) errors.push(`位深: ${wavInfo.bitsPerSample}bit ≠ 16bit`)
      if (wavInfo.channels !== 1) errors.push(`声道: ${wavInfo.channels} ≠ 1（单声道）`)
    } catch (e) {
      errors.push(`WAV 解析失败: ${e.message}`)
    }
  }

  if (duration !== null) {
    if (duration < 30) errors.push(`时长过短: ${duration.toFixed(1)}s < 30s`)
    if (duration > 60) errors.push(`时长过长: ${duration.toFixed(1)}s > 60s`)
  }

  // 峰值检查
  if (ext === 'mp3' || ext === 'ogg') {
    peak = probePeak(actualPath)
  }
  if (peak !== null && peak > -3) {
    errors.push(`峰值过高: ${peak.toFixed(1)}dB > -3dB`)
  }

  if (errors.length === 0) {
    const durStr = duration !== null ? ` ${duration.toFixed(1)}s` : ''
    const peakStr = peak !== null ? ` ${peak.toFixed(1)}dB` : ''
    console.log(
      `✓ ${spec.key} (${ext}${durStr}${peakStr} ${sizeMB.toFixed(1)}MB)`
    )
  } else {
    console.log(`✗ ${spec.key}: ${errors.join('; ')}`)
    totalErrors += errors.length
  }
}

console.log(
  `\n${totalErrors === 0 ? '✓ 全部通过' : `✗ ${totalErrors} 个错误, ${totalWarnings} 个警告`}`
)
process.exit(totalErrors > 0 ? 1 : 0)
