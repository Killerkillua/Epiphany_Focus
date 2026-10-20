/**
 * 全屏学习窗口壳。
 * 内容窗口、悬浮助手、全屏锁和进度读取与具体站点解耦，
 * 实现仍与 B 站播放窗口共用同一活动会话（见 navigation/biliWindow.ts），
 * 因此本地视频、白名单网站和 B 站不会同时打开两套专注窗口。
 */
export {
  closeVideo as closeStudyWindow,
  getContext as getStudyContext,
  getPlaybackMeta,
  getVideoDuration,
  getVideoPosition,
  openLearningContent,
  seekTo as seekStudy,
  type LearningContentLaunch,
  type PlaybackMeta
} from '../navigation/biliWindow'
