import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * 受信任的本地播放页。只播放 tomato-media 令牌，不接收文件系统路径。
 */
export default function LocalPlayerApp(): JSX.Element {
  const params = useMemo(() => new URLSearchParams(window.location.hash.split('?')[1] ?? ''), [])
  const token = params.get('token') ?? ''
  const extension = (params.get('ext') ?? '').toLowerCase()
  const startAt = Number(params.get('t') ?? '0')
  const unreliable = extension === '.mkv' || extension === '.flv' || extension === 'mkv' || extension === 'flv'
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onReady = (): void => {
      if (startAt > 0 && Number.isFinite(video.duration)) video.currentTime = startAt
    }
    video.addEventListener('loadedmetadata', onReady)
    return () => video.removeEventListener('loadedmetadata', onReady)
  }, [startAt])

  const src = token ? `tomato-media://play/${encodeURIComponent(token)}` : ''

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0f1115',
        color: '#e8eaed',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24
      }}
    >
      {unreliable && !error && (
        <div style={{ maxWidth: 720, color: '#f5c16c', fontSize: 14, lineHeight: 1.6 }}>
          当前文件是 {extension || '该格式'}。内置播放器稳定支持 H.264/AAC
          MP4。如果无法播放，请先无损转封装或转换为 MP4，再重新打开。
        </div>
      )}
      {error && (
        <div style={{ maxWidth: 720, color: '#ff8b8b', fontSize: 14, lineHeight: 1.6 }}>{error}</div>
      )}
      {src ? (
        <video
          ref={videoRef}
          src={src}
          controls
          autoPlay
          style={{ width: 'min(1200px, 100%)', maxHeight: '80vh', background: '#000' }}
          onError={() => {
            const code = videoRef.current?.error?.code
            setError(
              code === 4 || unreliable
                ? '这个文件无法直接播放。请将视频无损转封装或转换为 H.264/AAC MP4 后再打开。'
                : '视频加载失败。请确认文件仍在原位置，然后重新选择。'
            )
          }}
        />
      ) : (
        <div>缺少播放凭证</div>
      )}
    </div>
  )
}
