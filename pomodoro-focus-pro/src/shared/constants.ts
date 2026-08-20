/**
 * 学习模式共享常量：模式 key → 展示名 / 颜色。
 * UI 层统一从这里取值，新增模式只需在此登记一处，无需改动组件代码。
 */

/** 模式展示名（专注 / B 站学习 / 英语学习） */
export const MODE_LABELS: Record<string, string> = {
  focus: '专注',
  bili: 'B 站学习',
  english: '英语学习'
}

/** 模式主题色（首页模式卡片 / 图表） */
export const MODE_COLORS: Record<string, string> = {
  focus: '#3ddc97',
  bili: '#ff6b4a',
  english: '#4da3ff'
}

/** 取模式的展示名，未知模式回退为原 key */
export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode
}

/** 取模式的主题色，未知模式回退为默认蓝 */
export function modeColor(mode: string): string {
  return MODE_COLORS[mode] ?? '#4da3ff'
}
