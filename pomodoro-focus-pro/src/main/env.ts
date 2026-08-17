import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 本地敏感配置加载（.env 存储，审查 C1 修复的配套机制）。
 *
 * 背景：API Key 不允许硬编码进源码 / 打包产物。开发与本机自用时，
 * 把 Key 写入应用根目录 .env（已被 .gitignore 排除），主进程启动时
 * 读取并注入 process.env，再灌入 settings 默认值。
 *
 * 打包分发版不内置 .env（extraResources 未包含），用户通过
 * 「设置 → AI 设置」BYOK 填写自己的 Key。
 */

export const ENV_KEY_API_KEY = 'POMODORO_AI_API_KEY'

/** 轻量 .env 解析：KEY=VALUE（支持空行、# 注释、单/双引号包裹） */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

/**
 * 加载应用根目录的 .env 到 process.env（仅当对应变量尚未设置时写入，
 * 不覆盖外部显式注入的环境变量）。
 */
export function loadEnvFile(): void {
  try {
    const envPath = join(app.getAppPath(), '.env')
    if (!existsSync(envPath)) return
    const vars = parseEnvFile(readFileSync(envPath, 'utf-8'))
    for (const [key, value] of Object.entries(vars)) {
      if (value && process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  } catch {
    // .env 缺失 / 解析失败时静默降级（无 Key = 演示模式）
  }
}
