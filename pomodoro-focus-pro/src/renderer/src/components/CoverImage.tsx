import { useEffect, useState } from 'react'
import { PlayCircleOutlined } from '@ant-design/icons'

/**
 * B 站封面图（带防盗链降级链）：
 * 1. 首选 bili-image:// 代理地址（主进程注入 Referer 拉图）
 * 2. 失败 → 直连 CDN 原始地址（主进程 webRequest 兜底注入 Referer）
 * 3. 再失败 → 渐变 + 播放图标占位（不再显示破损 <img>）
 * 右键可复制原始封面链接（调试用）。
 */

interface CoverImageProps {
  /** 首选代理地址（bili-image://…） */
  src: string
  /** 原始 CDN 地址（降级源 / 复制链接） */
  fallbackSrc: string
  alt: string
}

function CoverImage({ src, fallbackSrc, alt }: CoverImageProps): JSX.Element {
  const candidates = [src, fallbackSrc].filter(Boolean)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)

  // 换一张封面时重置加载状态
  useEffect(() => {
    setAttempt(0)
    setLoaded(false)
  }, [src, fallbackSrc])

  const failed = attempt >= candidates.length
  const currentSrc = failed ? undefined : candidates[attempt]

  if (failed) {
    return (
      <div className="bili-card-cover is-error" role="img" aria-label={alt}>
        <PlayCircleOutlined className="bili-cover-placeholder" />
      </div>
    )
  }

  return (
    <div className={`bili-card-cover ${loaded ? '' : 'is-loading'}`}>
      <img
        src={currentSrc}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setAttempt((n) => n + 1)}
        onContextMenu={(e) => {
          e.preventDefault()
          void navigator.clipboard.writeText(fallbackSrc)
        }}
      />
    </div>
  )
}

export default CoverImage
