import { memo } from 'react'
import appLogo from '../assets/icon.png'

interface CustomTitlebarProps {
  isMaximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}

function CustomTitlebarComponent({
  isMaximized,
  onMinimize,
  onToggleMaximize,
  onClose
}: CustomTitlebarProps): JSX.Element {
  return (
    <header className="custom-titlebar" onDoubleClick={onToggleMaximize}>
      <div className="custom-titlebar-drag-region">
        <div className="custom-titlebar-left">
          <img src={appLogo} alt="Logo" className="custom-titlebar-icon" draggable={false} />
          <span className="custom-titlebar-title">静界专注</span>
          <span className="custom-titlebar-tag">Epiphany Focus</span>
        </div>
      </div>

      <div className="custom-titlebar-controls" onDoubleClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="titlebar-btn titlebar-btn-minimize"
          onClick={onMinimize}
          title="最小化"
          aria-label="最小化"
        >
          <svg width="11" height="11" viewBox="0 0 11 11">
            <line x1="1" y1="5.5" x2="10" y2="5.5" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>

        <button
          type="button"
          className="titlebar-btn titlebar-btn-maximize"
          onClick={onToggleMaximize}
          title={isMaximized ? '向下还原' : '最大化'}
          aria-label={isMaximized ? '向下还原' : '最大化'}
        >
          {isMaximized ? (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path
                d="M3.5 2.5H8.5V7.5"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect
                x="1.5"
                y="3.5"
                width="6"
                height="6"
                stroke="currentColor"
                strokeWidth="1.1"
                fill="none"
              />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <rect
                x="1.5"
                y="1.5"
                width="8"
                height="8"
                stroke="currentColor"
                strokeWidth="1.1"
                fill="none"
              />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="titlebar-btn titlebar-btn-close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
        >
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path
              d="M2 2L9 9M9 2L2 9"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </header>
  )
}

export const CustomTitlebar = memo(CustomTitlebarComponent)
export default CustomTitlebar
