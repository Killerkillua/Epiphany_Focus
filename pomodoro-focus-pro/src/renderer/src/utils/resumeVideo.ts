import type { PlayRecord } from '../../../shared/stats'
import { useSessionStore } from '../store/sessionStore'

/**
 * 续学（M2）：打开视频并跳转到上次播放位置（视频学习原生 ?t= 参数，加载即定位），
 * 自动开始播放。悬浮面板 / 学习助手抽屉的"续学 / 点击记录卡片"共用。
 * 会话上限时长取当前学习会话计划时长（首页时长浮层 / 计时条预设）。
 */
export async function resumeVideo(rec: PlayRecord): Promise<void> {
  let autoFullscreen = true
  try {
    const settings = await window.api.settings.get()
    autoFullscreen = settings.bili.autoFullscreen
  } catch {
    /* 设置不可用时取默认 */
  }
  const plannedMs = useSessionStore.getState().snapshot.durationMs
  await window.api.bili.openVideo({
    bvid: rec.bvid,
    autoFullscreen,
    title: rec.title || undefined,
    plannedMs,
    seekSeconds: rec.lastPositionS > 0 ? rec.lastPositionS : undefined,
    source: 'resume',
    coverUrl: rec.coverUrl || undefined,
    author: rec.author || undefined
  })
}
