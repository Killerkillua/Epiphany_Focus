import type { SyntheticNoiseKind } from '../../../shared/audio'

/**
 * 合成层噪声缓冲生成（零成本，M1 交付）：
 * - 白噪：均匀随机样本
 * - 粉噪：Paul Kellet 一阶滤波器近似（-3dB/oct 衰减）
 * - 棕噪：白噪积分（布朗运动，低频为主）
 * 生成后统一峰值归一化到 0.9，避免削波；
 * 随机噪声环接无周期不连续，天然无缝（引擎仍统一走双节点交叉淡入淡出）。
 */

/** 峰值归一化（默认 0.9，防削波） */
function normalizePeak(data: Float32Array, peak = 0.9): void {
  let max = 0
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i])
    if (abs > max) max = abs
  }
  if (max > 0.0001) {
    const scale = peak / max
    for (let i = 0; i < data.length; i++) data[i] *= scale
  }
}

function fillWhite(data: Float32Array): void {
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1
  }
}

function fillPink(data: Float32Array): void {
  // Paul Kellet 粉色噪声近似（多级一阶滤波 + 白噪混合）
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let b6 = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    b0 = 0.99886 * b0 + white * 0.0555179
    b1 = 0.99332 * b1 + white * 0.0750759
    b2 = 0.969 * b2 + white * 0.153852
    b3 = 0.8665 * b3 + white * 0.3104856
    b4 = 0.55 * b4 + white * 0.5329522
    b5 = -0.7616 * b5 - white * 0.016898
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
    b6 = white * 0.115926
  }
}

function fillBrown(data: Float32Array): void {
  // 白噪积分（布朗运动）：随机游走低频主导
  let last = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    last = (last + 0.02 * white) / 1.02
    data[i] = last * 3.5
  }
}

/** 生成指定种类的合成噪声缓冲（单声道，可无缝环接） */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  kind: SyntheticNoiseKind,
  seconds = 4
): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  switch (kind) {
    case 'white':
      fillWhite(data)
      break
    case 'pink':
      fillPink(data)
      break
    case 'brown':
      fillBrown(data)
      break
  }
  normalizePeak(data)
  return buffer
}
