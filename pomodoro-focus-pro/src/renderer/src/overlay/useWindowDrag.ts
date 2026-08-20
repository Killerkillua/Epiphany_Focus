import { useCallback, useRef, useState } from 'react'

/**
 * 悬浮球窗口拖动钩子（渲染层指针事件 → IPC 移动 overlay 窗口）。
 *
 * 为什么不用 Electron 原生 -webkit-app-region: drag：
 * 原生拖拽区域会吞掉全部指针事件（click / hover 均不触发），
 * 而悬浮球需要「点击展开」「hover 滑出退出按钮」——两者都必须保留 DOM 事件。
 * 因此球体采用 Pointer Events 拖拽：mousedown → 捕获指针 → 逐帧增量调用
 * overlayMoveBy(dx, dy) 移动窗口；拖拽位移超阈值后抑制随后的 click（避免误触展开）。
 *
 * 展开态面板的 header 标题栏仍使用原生 drag（无点击需求，按钮为 no-drag）。
 */
export function useWindowDrag(): {
  /** 绑定到可拖拽元素（onPointerDown） */
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  /** 是否正在拖拽（用于 cursor / 样式切换） */
  dragging: boolean
  /** 若本次指针序列已被当作拖拽消费，返回 true —— 调用方应跳过 click 处理 */
  consumeDragClick: () => boolean
} {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)

  const consumeDragClick = useCallback((): boolean => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return true
    }
    return false
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || dragRef.current) return
    const el = e.currentTarget
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 忽略 */
    }
    const start = { pointerId: e.pointerId, lastX: e.screenX, lastY: e.screenY, moved: false }
    dragRef.current = start

    const onMove = (ev: PointerEvent): void => {
      const d = dragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      const dx = ev.screenX - d.lastX
      const dy = ev.screenY - d.lastY
      d.lastX = ev.screenX
      d.lastY = ev.screenY
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        if (!d.moved) {
          d.moved = true
          setDragging(true)
        }
        void window.api.bili.overlayMoveBy(dx, dy).catch(() => {
          /* 会话已结束，忽略 */
        })
      }
    }
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== start.pointerId) return
      const d = dragRef.current
      dragRef.current = null
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      try {
        el.releasePointerCapture(ev.pointerId)
      } catch {
        /* 忽略 */
      }
      setDragging(false)
      if (d?.moved) {
        // 拖拽结束后紧跟的 click 不触发（防止误触发展开面板）
        suppressClickRef.current = true
        setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }, [])

  return { onPointerDown, dragging, consumeDragClick }
}
