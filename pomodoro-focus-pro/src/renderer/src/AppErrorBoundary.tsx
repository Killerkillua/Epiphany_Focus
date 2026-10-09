import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'

/**
 * 渲染子树的错误边界。
 * 只捕获渲染期异常；事件回调、异步请求和主进程崩溃不会进入这里。
 * 兜底界面直接调 emergency:exit：强制锁定的全屏由主进程施加，
 * 只做 location.reload() 不会解除这把锁。
 */
interface BoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] 渲染异常', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) return <CrashFallback error={this.state.error} />
    return this.props.children
  }
}

function CrashFallback({ error }: { error: Error }): JSX.Element {
  const [code, setCode] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api?.emergency?.setPullBackPaused(true).catch(() => {
      /* 会话已结束或通道不可用 */
    })
    return () => {
      void window.api?.emergency?.setPullBackPaused(false).catch(() => {
        /* 同上 */
      })
    }
  }, [])

  const handleEmergencyExit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setHint('')
    try {
      const result = await window.api.emergency.exit(code)
      if (result.ok) {
        setHint('已解除强制锁定，正在重新加载')
        window.location.reload()
        return
      }
      setHint(
        result.retryInSec
          ? `${result.error ?? '恢复码错误'}（${result.retryInSec}s）`
          : (result.error ?? '恢复码错误')
      )
    } catch (err) {
      setHint(err instanceof Error ? err.message : '请求失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-crash">
      <div className="app-crash-card">
        <h1>界面渲染中断</h1>
        <p>
          输入紧急恢复码可解除主进程已施加的全屏锁，验证成功后会重新加载界面。重新加载本身不会解除这把锁。
        </p>
        {error.message ? <p className="app-crash-detail">{error.message}</p> : null}
        <input
          type="password"
          autoFocus
          value={code}
          placeholder="紧急恢复码"
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleEmergencyExit()
          }}
        />
        <div className="app-crash-actions">
          <button
            type="button"
            className="app-crash-primary"
            disabled={busy}
            onClick={() => void handleEmergencyExit()}
          >
            {busy ? '验证中…' : '验证并退出'}
          </button>
          <button
            type="button"
            className="app-crash-secondary"
            disabled={busy}
            onClick={() => window.location.reload()}
          >
            重新加载界面
          </button>
        </div>
        {hint ? <p className="app-crash-hint">{hint}</p> : null}
      </div>
    </div>
  )
}
