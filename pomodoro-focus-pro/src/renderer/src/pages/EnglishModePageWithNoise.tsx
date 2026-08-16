import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import EnglishModePage from './EnglishModePage'
import NoiseControl from '../components/NoiseControl'

/**
 * 英语学习模式 + 白噪音组合容器。
 * 通过 Portal 将 NoiseControl 注入到 EnglishModePage 侧栏，
 * 不修改 EnglishModePage / NoiseControl 等现有模块的任何代码。
 *
 * 设计要点：
 * - NoiseControl 直接复用，不做裁剪（功能完整性）
 * - 专注联动配置（autoPlayOnStart / restAction / duckLevel）在英语模式中
 *   保留在 UI 中但不被触发（英语模式无计时器）
 * - 全局热键 Ctrl+Shift+↑/↓ 已在 App.tsx 注册，跨页面生效
 * - noiseEngine 是全局单例，设置跨模式自动共享
 */
function EnglishModePageWithNoise(): JSX.Element {
  const [sidebarEl, setSidebarEl] = useState<Element | null>(null)
  const observerRef = useRef<MutationObserver | null>(null)

  useEffect(() => {
    const findSidebar = (): Element | null =>
      document.querySelector('.english-side')

    // 首次尝试（EnglishModePage 可能已渲染）
    const el = findSidebar()
    if (el) {
      setSidebarEl(el)
      return
    }

    // 若尚未渲染，用 MutationObserver 监听 DOM 变化
    observerRef.current = new MutationObserver(() => {
      const found = findSidebar()
      if (found) {
        setSidebarEl(found)
        observerRef.current?.disconnect()
      }
    })
    observerRef.current.observe(document.body, { childList: true, subtree: true })

    return () => {
      observerRef.current?.disconnect()
    }
  }, [])

  return (
    <>
      <EnglishModePage />
      {sidebarEl &&
        createPortal(
          <div className="english-noise-wrapper">
            <NoiseControl />
          </div>,
          sidebarEl
        )}
    </>
  )
}

export default EnglishModePageWithNoise