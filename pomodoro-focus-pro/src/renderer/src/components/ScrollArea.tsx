import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, UIEvent } from 'react'

export interface ScrollAreaHandle {
  /** 原生滚动容器（viewport），供外部 scrollTop / scrollTo 等操作 */
  viewport: HTMLDivElement | null
}

interface ScrollAreaProps {
  className?: string
  style?: CSSProperties
  children?: ReactNode
  /** 横向滚动模式（代码块等），默认垂直 */
  horizontal?: boolean
}

interface Metrics {
  vRatio: number
  vTop: number
  vHeight: number
  hRatio: number
  hLeft: number
  hWidth: number
}

const EMPTY: Metrics = { vRatio: 1, vTop: 0, vHeight: 0, hRatio: 1, hLeft: 0, hWidth: 0 }

/**
 * 自定义滚动区域：JS 渲染胶囊滑块（8px / 99px 圆角 / 浅色 / 无轨道）。
 * 原生滚动条通过「加宽/加高 + 外层 overflow: hidden 裁剪」隐藏——不依赖
 * ::-webkit-scrollbar / scrollbar-color，在任何系统主题（含经典主题）下都生效。
 */
const ScrollArea = forwardRef<ScrollAreaHandle, ScrollAreaProps>(function ScrollArea(
  { className, style, children, horizontal },
  ref
) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** 拖拽期间挂在 window 上的事件清理函数（组件卸载时兜底移除，避免幽灵监听） */
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const [m, setM] = useState<Metrics>(EMPTY)

  const update = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = el
    // 阈值容错：可滚动距离不足 2px 视为无需滚动，不显示滑块
    const canV = scrollHeight - clientHeight > 2
    const canH = scrollWidth - clientWidth > 2
    const vRatio = canV ? clientHeight / scrollHeight : 1
    const hRatio = canH ? clientWidth / scrollWidth : 1
    const vHeight = canV ? Math.max(vRatio * clientHeight, 24) : 0
    const hWidth = canH ? Math.max(hRatio * clientWidth, 24) : 0
    const vTop = canV ? (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - vHeight) : 0
    const hLeft = canH ? (scrollLeft / (scrollWidth - clientWidth)) * (clientWidth - hWidth) : 0
    const next: Metrics = { vRatio, vTop, vHeight, hRatio, hLeft, hWidth }
    // 指标无变化时返回原引用，跳过多余渲染（避免 RO 连锁触发无意义的 setState）
    setM((prev) =>
      prev.vRatio === next.vRatio &&
      prev.vTop === next.vTop &&
      prev.vHeight === next.vHeight &&
      prev.hRatio === next.hRatio &&
      prev.hLeft === next.hLeft &&
      prev.hWidth === next.hWidth
        ? prev
        : next
    )
  }, [])

  // 环境无关：用 JS 实测原生滚动条尺寸，把滚动条撑出可视区由外层裁剪
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    if (horizontal) {
      const sbh = el.offsetHeight - el.clientHeight // 水平滚动条高度（overflow-x: scroll 时恒占位）
      el.style.paddingBottom = '24px'
      el.style.marginBottom = `${-(24 + sbh)}px`
    } else {
      const sbw = el.offsetWidth - el.clientWidth // 垂直滚动条宽度
      el.style.paddingRight = '24px'
      el.style.width = `calc(100% + ${24 + sbw}px)`
    }
  }, [horizontal])

  useEffect(() => {
    update()
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => update())
    ro.observe(el)
    // 同时观察内容容器：页面切换 / 异步加载 / AI 流式追加等内容尺寸变化时，
    // viewport 自身尺寸不变、RO 不会触发，仅观察 viewport 会导致滚动条指标
    // 停留在旧状态（滑块尺寸/位置不刷新）
    const contentEl = contentRef.current
    if (contentEl) ro.observe(contentEl)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      // 组件卸载时若仍处于拖拽，移除 window 监听防止泄漏
      dragCleanupRef.current?.()
      dragCleanupRef.current = null
    }
  }, [update])

  useImperativeHandle(
    ref,
    () => ({
      get viewport() {
        return viewportRef.current
      }
    }),
    []
  )

  const startDrag = (e: ReactMouseEvent, isH: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const el = viewportRef.current
    if (!el) return
    const startPos = isH ? e.clientX : e.clientY
    const startScroll = isH ? el.scrollLeft : el.scrollTop
    const maxScroll = isH ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    if (maxScroll <= 0) return
    const trackSize = isH ? el.clientWidth : el.clientHeight
    const thumbSize = isH ? m.hWidth : m.vHeight
    // 防除零：轨道与滑块等宽（或数值异常）时无拖拽余量，直接忽略
    const denom = trackSize - thumbSize
    if (!Number.isFinite(denom) || denom <= 0) return
    const move = (ev: globalThis.MouseEvent) => {
      const delta = (isH ? ev.clientX : ev.clientY) - startPos
      if (isH) el.scrollLeft = startScroll + (delta / denom) * maxScroll
      else el.scrollTop = startScroll + (delta / denom) * maxScroll
    }
    const cleanup = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', cleanup)
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null
    }
    dragCleanupRef.current = cleanup
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', cleanup)
  }

  return (
    <div
      className={`scroll-area${horizontal ? ' scroll-area--h' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <div ref={viewportRef} className="scroll-area__viewport" onScroll={update}>
        <div ref={contentRef} className="scroll-area__content">
          {children}
        </div>
      </div>
      {!horizontal && m.vRatio < 1 && (
        <div className="scroll-area__track scroll-area__track--v">
          <div
            className="scroll-area__thumb"
            style={{ height: m.vHeight, transform: `translateY(${m.vTop}px)` }}
            onMouseDown={(e) => startDrag(e, false)}
          />
        </div>
      )}
      {horizontal && m.hRatio < 1 && (
        <div className="scroll-area__track scroll-area__track--h">
          <div
            className="scroll-area__thumb"
            style={{ width: m.hWidth, transform: `translateX(${m.hLeft}px)` }}
            onMouseDown={(e) => startDrag(e, true)}
          />
        </div>
      )}
    </div>
  )
})

export default ScrollArea
