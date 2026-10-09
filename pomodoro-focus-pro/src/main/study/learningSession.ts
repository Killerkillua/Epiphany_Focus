import { session, type Session } from 'electron'

const PARTITION = 'persist:learning-web'
let learningWebSession: Session | null = null

/**
 * 第三方学习网站使用独立持久化分区，保留登录态，
 * 并与主界面、本地播放器隔离 Cookie / Storage。
 * 下载与敏感权限默认拒绝。
 */
export function getLearningWebSession(): Session {
  if (learningWebSession) return learningWebSession
  const partitioned = session.fromPartition(PARTITION)
  partitioned.on('will-download', (event) => {
    event.preventDefault()
  })
  partitioned.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  learningWebSession = partitioned
  return partitioned
}
