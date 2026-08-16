import { CROSSFADE_SEC } from '../../../shared/audio'

/**
 * 双节点交叉淡入淡出无缝循环（方案 2.8 引擎核心）。
 *
 * 要点：
 * 1. 每个缓冲结束前 fadeSec（默认 1.5s）启动第二个同源节点，新旧两节点同时发声；
 * 2. 交接期内旧节点线性淡出（1→0.0001）、新节点线性淡入（0.0001→1），
 *    增益全程连续，人耳无接缝、无咔哒声；
 * 3. 交接点按「当前节点起点 + (缓冲时长 - fadeSec)」链式推进，lookahead 定时器提前调度；
 * 4. 停止时对输出增益做 50ms 快速线性淡出，避免硬切咔哒。
 *
 * 拓扑：BufferSource(A/B) → NodeGain(A/B) → outGain（= 本轨音量）→ 外部 MasterGain → destination
 */

export interface CrossfadeLoopOptions {
  /** 交叉淡入淡出时长（秒），默认 1.5 */
  fadeSec?: number
  /** lookahead 调度周期（毫秒），默认 250 */
  lookaheadMs?: number
}

interface LoopNode {
  src: AudioBufferSourceNode
  gain: GainNode
  /** 起点（ctx.currentTime 轴） */
  startTime: number
  /** 已调度停止（避免重复 stop 抛异常） */
  stopScheduled: boolean
}

export class CrossfadeLoop {
  private readonly ctx: AudioContext
  private readonly buffer: AudioBuffer
  private readonly fadeSec: number
  private readonly lookaheadMs: number
  /** 本轨输出增益：既是交叉淡出的汇聚点，也是轨道音量控制点 */
  private readonly outGain: GainNode
  private nodes: LoopNode[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private current: LoopNode | null = null
  private nextHandoffAt = 0
  private started = false

  constructor(
    ctx: AudioContext,
    buffer: AudioBuffer,
    destination: AudioNode,
    options: CrossfadeLoopOptions = {}
  ) {
    this.ctx = ctx
    this.buffer = buffer
    this.fadeSec = options.fadeSec ?? CROSSFADE_SEC
    this.lookaheadMs = options.lookaheadMs ?? 250
    this.outGain = ctx.createGain()
    this.outGain.gain.value = 1
    this.outGain.connect(destination)
  }

  /** 轨道音量（0-1），映射到 outGain */
  setGain(value: number): void {
    const now = this.ctx.currentTime
    this.outGain.gain.cancelScheduledValues(now)
    this.outGain.gain.setValueAtTime(Math.max(this.outGain.gain.value, 0.0001), now)
    this.outGain.gain.linearRampToValueAtTime(clamp01(value), now + 0.03)
  }

  start(): void {
    if (this.started) return
    this.started = true
    const now = this.ctx.currentTime
    // 首个节点：50ms 起始淡入，防开播咔哒
    this.current = this.spawn(now, 0.05)
    this.nextHandoffAt = now + Math.max(this.fadeSec, this.buffer.duration - this.fadeSec)
    this.timer = setInterval(() => this.schedule(), this.lookaheadMs)
  }

  /** lookahead 调度：到交接窗口即启动下一节点并做交叉淡入淡出 */
  private schedule(): void {
    const now = this.ctx.currentTime
    const cur = this.current
    if (!cur) return

    while (this.nextHandoffAt - now <= this.fadeSec) {
      const handoff = Math.max(this.nextHandoffAt, now + 0.02)
      const next = this.spawn(handoff, 0)
      // 新节点淡入
      next.gain.gain.linearRampToValueAtTime(1, handoff + this.fadeSec)
      // 旧节点淡出并在自然结束点停止
      cur.gain.gain.cancelScheduledValues(handoff)
      cur.gain.gain.setValueAtTime(Math.max(cur.gain.gain.value, 0.0001), handoff)
      cur.gain.gain.linearRampToValueAtTime(0.0001, handoff + this.fadeSec)
      cur.src.stop(handoff + this.fadeSec + 0.03)
      cur.stopScheduled = true
      this.current = next
      this.nextHandoffAt += Math.max(this.fadeSec, this.buffer.duration - this.fadeSec)
    }

    // 清理已结束节点（释放引用，防无限增长）
    const cutoff = now - 2
    this.nodes = this.nodes.filter((node) => {
      if (node.startTime + this.buffer.duration + 0.1 < cutoff) {
        node.src.disconnect()
        node.gain.disconnect()
        return false
      }
      return true
    })
  }

  /** 创建节点并接到 outGain；fadeInSec>0 时做起始淡入 */
  private spawn(startTime: number, fadeInSec: number): LoopNode {
    const src = this.ctx.createBufferSource()
    src.buffer = this.buffer
    const gain = this.ctx.createGain()
    src.connect(gain)
    gain.connect(this.outGain)
    if (fadeInSec > 0) {
      gain.gain.setValueAtTime(0.0001, startTime)
      gain.gain.linearRampToValueAtTime(1, startTime + fadeInSec)
    } else {
      gain.gain.setValueAtTime(0.0001, startTime)
    }
    src.start(startTime)
    const node: LoopNode = { src, gain, startTime, stopScheduled: false }
    this.nodes.push(node)
    return node
  }

  /** 停止：输出 50ms 快速淡出后停掉全部节点并断开（一次性，实例不再复用） */
  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const now = this.ctx.currentTime
    this.outGain.gain.cancelScheduledValues(now)
    this.outGain.gain.setValueAtTime(Math.max(this.outGain.gain.value, 0.0001), now)
    this.outGain.gain.linearRampToValueAtTime(0.0001, now + 0.05)
    for (const node of this.nodes) {
      if (!node.stopScheduled) {
        try {
          node.src.stop(now + 0.06)
        } catch {
          /* 已停止则忽略 */
        }
      }
    }
    setTimeout(() => {
      for (const node of this.nodes) {
        node.src.disconnect()
        node.gain.disconnect()
      }
      this.nodes = []
      this.current = null
      this.outGain.disconnect()
    }, 120)
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
