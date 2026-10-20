import { getSettings } from './storage/settings'
import { recordEvent } from './storage/db'

/**
 * 匿名遥测（R-2，opt-in）：仅在设置 telemetryEnabled=true 时向本地 events 表记录。
 *
 * 隐私红线：
 * - 只记录计数 / 时长 / 档位 / 层级等非敏感字段；
 * - 绝不上送 bvid / topic / 笔记内容 / URL / 用户输入等任何内容文本；
 * - 默认关闭、可一键关闭；数据仅存本地 SQLite（后续可选的聚合上报需另行评审）。
 */
export function recordTelemetry(
  domain: string,
  action: string,
  payload?: Record<string, unknown>
): void {
  try {
    if (!getSettings().telemetryEnabled) return
    recordEvent(domain, action, payload)
  } catch {
    // 遥测失败静默，不影响主流程
  }
}
