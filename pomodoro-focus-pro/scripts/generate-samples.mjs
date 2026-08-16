/**
 * 白噪音采样素材程序化合成脚本（方案 2.8 §3 落地设计）。
 *
 * 纯 Node 运行，无第三方依赖。用声学配方生成 8 种 44.1kHz/16-bit 循环素材，
 * 输出 WAV；若本机有 ffmpeg 则额外转码 OGG（q4）。
 *
 * 用法：node scripts/generate-samples.mjs
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 44100
const DUR = 45          // 45s 循环素材
const N = SR * DUR
const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'resources', 'audio')

/* ---- 噪声原语 ---- */

function white(n = N) {
  return Float32Array.from({ length: n }, () => Math.random() * 2 - 1)
}

function pink(n = N) {
  // Paul Kellet 三极近似
  const out = new Float32Array(n)
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25
  }
  return out
}

function brown(n = N) {
  const out = new Float32Array(n)
  let last = 0
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1
    last = (last + 0.02 * w) / 1.02
    out[i] = last * 3.5
  }
  return out
}

/* ---- 双二阶滤波器（RBJ 系数） ---- */

function biquad(src, { type, fc, q = 0.707 }) {
  const w0 = (2 * Math.PI * fc) / SR
  const alpha = Math.sin(w0) / (2 * q)
  const cw = Math.cos(w0)
  let b0, b1, b2, a0, a1, a2
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
  } else if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
  } else {
    // bandpass（peak 增益 = 1）
    b0 = alpha; b1 = 0; b2 = -alpha
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
  }
  const out = new Float32Array(src.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < src.length; i++) {
    const x = src[i]
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x; y2 = y1; y1 = y
    out[i] = y
  }
  return out
}

/* ---- 辅助：混音 / 瞬态放置 / 种子随机 ---- */

function mix(dest, src, gain = 1) {
  for (let i = 0; i < dest.length; i++) dest[i] += src[i] * gain
}

function makeRng(seed) {
  let s = seed
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
}

/** 在 1.6s ~ DUR-1.6s 区间随机放置瞬态（避开首尾接缝） */
function placeEvents(out, count, make, seed = 1) {
  const rand = makeRng(seed)
  for (let i = 0; i < count; i++) {
    const t = 1.6 + rand() * (DUR - 3.2)
    make(out, Math.floor(t * SR), rand)
  }
}

/* ---- 写出 WAV（16-bit PCM，峰值 -3dB） ---- */

function writeWav(name, samples) {
  const num = samples.length
  const dataSize = num * 2
  const buf = Buffer.alloc(44 + dataSize)

  // RIFF header
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')

  // fmt chunk
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)       // chunk size
  buf.writeUInt16LE(1, 20)        // PCM
  buf.writeUInt16LE(1, 22)        // mono
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)   // byte rate
  buf.writeUInt16LE(2, 32)        // block align
  buf.writeUInt16LE(16, 34)       // bits per sample

  // data chunk
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)

  let peak = 0
  for (let i = 0; i < num; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    if (Math.abs(s) > peak) peak = Math.abs(s)
  }
  // 归一化到 -3dB（0.707 倍）
  const scale = peak > 0 ? 0.707 / peak : 1
  for (let i = 0; i < num; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * scale))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  const outPath = join(OUT, name + '.wav')
  writeFileSync(outPath, buf)
  console.log(`  ✓ ${name}.wav (${(dataSize / 1024 / 1024).toFixed(1)}MB, peak ${(peak * scale * -1).toFixed(1)}dB)`)
  return peak * scale
}

/* ---- 转码 OGG（ffmpeg 可用时） ---- */

function maybeToOgg(name) {
  const wavPath = join(OUT, name + '.wav')
  const oggPath = join(OUT, name + '.ogg')
  const result = spawnSync('ffmpeg', [
    '-y', '-i', wavPath, '-c:a', 'libvorbis', '-q:a', '4', oggPath
  ], { stdio: 'pipe' })
  if (result.status === 0) {
    unlinkSync(wavPath)
    return true
  }
  if (result.error && result.error.code === 'ENOENT') {
    console.log(`    (ffmpeg 未安装，保留 WAV)`)
  } else {
    console.log(`    ffmpeg 转码失败，保留 WAV: ${result.stderr?.toString().slice(0, 80)}`)
  }
  return false
}

/* ================================================================
 * 8 种素材合成配方
 * ================================================================ */

function synthRain() {
  // 雨幕：白噪→带通(1–4kHz) + 隆隆底：棕噪低通(120Hz) + 雨滴瞬态
  const curtains = biquad(white(), { type: 'bandpass', fc: 2000, q: 0.6 })
  const rumble = biquad(brown(), { type: 'lowpass', fc: 120 })
  const out = new Float32Array(N)
  mix(out, curtains, 0.9)
  mix(out, rumble, 0.5)

  placeEvents(out, 90, (o, i, rand) => {
    // 雨滴：8ms 白噪脉冲，带通 3–6kHz
    const len = Math.floor(SR * 0.008)
    const fc = 3000 + rand() * 3000
    for (let j = i; j < Math.min(i + len, o.length); j++) {
      const t = (j - i) / len
      o[j] += (Math.random() * 2 - 1) * 0.35 * Math.exp(-t * 12)
    }
  }, 7)
  return out
}

function synthCafe() {
  // 人声 babble：白噪→带通(250–3kHz) + LFO 慢调制
  const babbleRaw = biquad(white(), { type: 'bandpass', fc: 1500, q: 0.4 })
  // 低频嗡声
  const hum = biquad(brown(), { type: 'lowpass', fc: 200 })
  const out = new Float32Array(N)
  // LFO 0.5Hz 调制 babble 音量
  for (let i = 0; i < N; i++) {
    const lfo = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.5 * i / SR)
    out[i] = babbleRaw[i] * 0.7 * lfo + hum[i] * 0.3
  }

  // 杯碟 clink 瞬态
  placeEvents(out, 25, (o, i, rand) => {
    const len = Math.floor(SR * 0.06)
    const freq = 2000 + rand() * 3000
    for (let j = i; j < Math.min(i + len, o.length); j++) {
      const t = (j - i) / len
      const s = Math.sin(2 * Math.PI * freq * (j - i) / SR) * 0.15 * Math.exp(-t * 30)
      o[j] += s
    }
  }, 13)
  return out
}

function synthForest() {
  // 叶响：宽频柔噪，带通 2–6kHz + 随机 AM
  const leavesRaw = biquad(white(), { type: 'bandpass', fc: 4000, q: 0.5 })
  const out = new Float32Array(N)
  const amSeed = makeRng(3)
  let amPhase = 0
  for (let i = 0; i < N; i++) {
    amPhase += (2 * Math.PI * 0.3) / SR
    if (amPhase > 2 * Math.PI) amPhase -= 2 * Math.PI
    const am = 0.6 + 0.4 * Math.sin(amPhase + amSeed() * 2)
    out[i] = leavesRaw[i] * 0.8 * am
  }

  // 合成鸟鸣（FM 上扫 1.5→3.5kHz）
  placeEvents(out, 40, (o, i, rand) => {
    const len = Math.floor(SR * (0.15 + rand() * 0.25))
    const startFreq = 1500 + rand() * 500
    const endFreq = 2500 + rand() * 1500
    for (let j = i; j < Math.min(i + len, o.length); j++) {
      const t = (j - i) / len
      const freq = startFreq + (endFreq - startFreq) * t
      const phase = 2 * Math.PI * freq * (j - i) / SR
      const env = Math.sin(t * Math.PI) // 自然包络
      o[j] += Math.sin(phase) * 0.2 * env
    }
  }, 11)
  return out
}

function synthLibrary() {
  // 极低底噪：低通棕噪 200Hz
  const hum = biquad(brown(), { type: 'lowpass', fc: 200 })
  const out = new Float32Array(N)
  mix(out, hum, 0.5)

  // 翻页瞬态：60ms 带通 1–2kHz 噪声包络
  placeEvents(out, 5, (o, i, rand) => {
    const len = Math.floor(SR * 0.06)
    for (let j = i; j < Math.min(i + len, o.length); j++) {
      const t = (j - i) / len
      const s = (Math.random() * 2 - 1) * 0.12 * Math.sin(t * Math.PI)
      o[j] += s
    }
  }, 19)
  return out
}

function synthWaves() {
  // 带通白噪 + 慢速幅度 LFO（涌浪），0.1Hz 周期整除 45s
  const noise = biquad(white(), { type: 'bandpass', fc: 400, q: 0.5 })
  const out = new Float32Array(N)
  // LFO 0.1Hz = 周期 10s，45s 恰 4.5 周期
  for (let i = 0; i < N; i++) {
    const lfo = 0.15 + 0.85 * Math.max(0, Math.sin(2 * Math.PI * 0.1 * i / SR))
    out[i] = noise[i] * lfo
  }
  return out
}

function synthFire() {
  // 低频噼啪基底：带通 100–800Hz
  const base = biquad(white(), { type: 'bandpass', fc: 350, q: 0.3 })
  const out = new Float32Array(N)
  mix(out, base, 0.8)

  // 爆裂瞬态：5ms 白噪脉冲 + 指数衰减
  placeEvents(out, 80, (o, i, rand) => {
    const len = Math.floor(SR * (0.003 + rand() * 0.008))
    const amp = 0.3 + rand() * 0.6
    for (let j = i; j < Math.min(i + len, o.length); j++) {
      const t = (j - i) / len
      o[j] += (Math.random() * 2 - 1) * amp * Math.exp(-t * 20)
    }
  }, 23)
  return out
}

function synthFan() {
  // 低通棕/粉噪 + 120Hz 电机 AM
  const noise = biquad(brown(), { type: 'lowpass', fc: 600 })
  const out = new Float32Array(N)
  // 0.2Hz LFO = 周期 5s，45s 恰 9 周期
  for (let i = 0; i < N; i++) {
    const am = 0.92 + 0.08 * Math.sin(2 * Math.PI * 0.2 * i / SR)
    out[i] = noise[i] * am
  }
  return out
}

function synthBirds() {
  // 合成 FM 鸣唱叠加 + 极淡环境底
  const ambience = biquad(white(), { type: 'bandpass', fc: 3000, q: 0.2 })
  const out = new Float32Array(N)
  mix(out, ambience, 0.08)

  // 鸟鸣：2–4 个音节的 1.5–4kHz 上扫
  placeEvents(out, 30, (o, i, rand) => {
    const syllables = 2 + Math.floor(rand() * 3)
    const syllLen = Math.floor(SR * (0.08 + rand() * 0.12))
    for (let s = 0; s < syllables; s++) {
      const start = i + s * syllLen
      const startFreq = 1500 + rand() * 1500
      const endFreq = 2000 + rand() * 2500
      for (let j = start; j < Math.min(start + syllLen, o.length); j++) {
        const t = (j - start) / syllLen
        const freq = startFreq + (endFreq - startFreq) * t
        const env = Math.sin(t * Math.PI)
        o[j] += Math.sin(2 * Math.PI * freq * (j - start) / SR) * 0.12 * env
      }
    }
  }, 17)
  return out
}

/* ================================================================
 * 主流程
 * ================================================================ */

const RECIPES = {
  rain: synthRain,
  cafe: synthCafe,
  forest: synthForest,
  library: synthLibrary,
  waves: synthWaves,
  fire: synthFire,
  fan: synthFan,
  birds: synthBirds
}

console.log('白噪音采样素材生成器')
console.log(`规格: ${SR / 1000}kHz / 16-bit / ${DUR}s / 峰值 -3dB`)
console.log(`输出: ${OUT}\n`)

mkdirSync(OUT, { recursive: true })

const hasFfmpeg = (() => {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe' })
  return r.status === 0
})()

console.log(`ffmpeg: ${hasFfmpeg ? '已检测到，将输出 OGG' : '未检测到，将输出 WAV'}\n`)

const results = []
for (const [name, fn] of Object.entries(RECIPES)) {
  console.log(`[${name}] 合成中...`)
  const samples = fn()
  writeWav(name, samples)
  const asOgg = hasFfmpeg ? maybeToOgg(name) : false
  results.push({ name, format: asOgg ? 'ogg' : 'wav' })
}

console.log(`\n完成！共生成 ${results.length} 个素材：`)
for (const r of results) {
  console.log(`  ${r.name}.${r.format}`)
}