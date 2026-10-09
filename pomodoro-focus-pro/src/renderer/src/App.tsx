import { useEffect, useRef, useState } from 'react'
import { Input, Layout, Menu, Modal, Typography, message } from 'antd'
import type { MenuProps } from 'antd'
import {
  HomeOutlined,
  BarChartOutlined,
  FileTextOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  CheckSquareOutlined,
  ClockCircleOutlined,
  PlayCircleOutlined,
  ReadOutlined
} from '@ant-design/icons'
import HomePage from './pages/HomePage'
import FocusPage from './pages/FocusPage'
import EnglishModePageWithNoise from './pages/EnglishModePageWithNoise'
import BiliModePage from './pages/BiliModePage'
import StatsPage from './pages/StatsPage'
import NotesPage from './pages/NotesPage'
import TasksPage from './pages/TasksPage'
import SettingsPage from './pages/SettingsPage'
import OverlayApp from './overlay/OverlayApp'
import LoginPage from './pages/LoginPage'
import AccountMenu from './components/AccountMenu'
import type { AuthState } from '../../shared/auth'
import ScrollArea from './components/ScrollArea'
import { noiseEngine } from './audio'
import CustomTitlebar from './components/CustomTitlebar'

const { Sider, Content } = Layout

type PageKey = 'home' | 'tasks' | 'focus' | 'english' | 'bili' | 'stats' | 'notes' | 'settings'

const NAV_ITEMS: MenuProps['items'] = [
  { key: 'home', icon: <HomeOutlined />, label: '首页' },
  { key: 'tasks', icon: <CheckSquareOutlined />, label: '任务清单' },
  { key: 'focus', icon: <ClockCircleOutlined />, label: '专注模式' },
  { key: 'english', icon: <ReadOutlined />, label: '英语学习' },
  { key: 'bili', icon: <PlayCircleOutlined />, label: '视频学习' },
  { key: 'stats', icon: <BarChartOutlined />, label: '学习统计' },
  { key: 'notes', icon: <FileTextOutlined />, label: '记事本' }
]

function App(): JSX.Element {
  const [route, setRoute] = useState<string>(window.location.hash)
  const [page, setPage] = useState<PageKey>('home')
  // 自适应侧栏：breakpoint="md"（<768px）自动折叠为图标栏；主窗口 minWidth 940 实际不触发，保留供 视频学习窗口与未来兼容；可手动折叠
  const [siderCollapsed, setSiderCollapsed] = useState(false)
  // 账号状态：null = 加载中；loggedOut 时展示登录页（主窗口业务页面不挂载）
  const [auth, setAuth] = useState<AuthState | null>(null)

  useEffect(() => {
    void window.api.auth
      .getState()
      .then(setAuth)
      .catch(() => setAuth({ status: 'loggedOut' }))
  }, [])

  // 悬浮面板窗口通过 #overlay 路由加载独立应用（透明置顶窗）
  useEffect(() => {
    const onHashChange = (): void => setRoute(window.location.hash)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // 全局热键 Ctrl+Shift+↑/↓ → 主进程转发音量步进 → 引擎主音量（盲操作，任何页面生效）
  useEffect(() => {
    return window.api.on<{ delta: number }>(window.api.events.audio.volumeChanged, ({ delta }) => {
      noiseEngine.stepMasterVolume(delta)
    })
  }, [])

  // 模式隔离：视频学习不需要白噪音，切换到视频学习页时自动停止白噪音
  useEffect(() => {
    if (page === 'bili') {
      noiseEngine.stopAll()
    }
  }, [page])

  // ===== 紧急退出（方案 2.10）：连按 5 次 Esc（3 秒窗口）弹密码框 =====
  const escTimes = useRef<number[]>([])
  const [emergencyOpen, setEmergencyOpen] = useState(false)
  const [emergencyCode, setEmergencyCode] = useState('')
  const [emergencyBusy, setEmergencyBusy] = useState(false)
  const [emergencyHint, setEmergencyHint] = useState('')

  // 自定义标题栏窗口最大化状态监听
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    void window.api?.window?.isMaximized?.().then((max) => {
      if (typeof max === 'boolean') setIsMaximized(max)
    }).catch(() => {})

    const eventName = window.api?.events?.window?.maximizeChanged
    if (!eventName) return
    return window.api?.on?.<boolean>(eventName, (maximized) => {
      setIsMaximized(maximized)
    })
  }, [])

  const handleMinimize = (): void => {
    void window.api?.window?.minimize?.().catch(() => {})
  }

  const handleToggleMaximize = (): void => {
    void window.api?.window?.maximize?.().catch(() => {})
  }

  const handleClose = (): void => {
    void window.api?.window?.close?.().catch(() => {})
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const now = Date.now()
      escTimes.current = [...escTimes.current.filter((t) => now - t < 3000), now]
      if (escTimes.current.length >= 5) {
        escTimes.current = []
        setEmergencyCode('')
        setEmergencyHint('')
        setEmergencyOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // P-2：主进程兜底 5×Esc（学习视频窗口聚焦/全屏时本窗口收不到 Esc，渲染层检测失效）：
  // 主进程在视频窗口侧检测到连按 5 次 Esc 后转发此事件，直接唤起紧急退出弹窗
  useEffect(() => {
    return window.api.on(window.api.events.bili.emergencyRequest, () => {
      setEmergencyCode('')
      setEmergencyHint('')
      setEmergencyOpen(true)
    })
  }, [])

  // P-2：弹窗打开期间暂停窗口守卫的失焦拉回——
  // 否则视频窗口失焦 400ms 后会被守卫抢回焦点，主窗口收不到输入，恢复码无法输入
  useEffect(() => {
    void window.api.emergency.setPullBackPaused(emergencyOpen).catch(() => {
      /* 会话已结束，忽略 */
    })
  }, [emergencyOpen])

  const handleEmergencyExit = async (): Promise<void> => {
    if (emergencyBusy) return
    setEmergencyBusy(true)
    try {
      const result = await window.api.emergency.exit(emergencyCode)
      if (result.ok) {
        message.success('已通过紧急恢复码退出强制会话')
        setEmergencyOpen(false)
        setEmergencyCode('')
      } else {
        setEmergencyHint(
          result.retryInSec
            ? `${result.error}（${result.retryInSec}s）`
            : (result.error ?? '恢复码错误')
        )
      }
    } catch (err) {
      setEmergencyHint(err instanceof Error ? err.message : '请求失败')
    } finally {
      setEmergencyBusy(false)
    }
  }

  if (route === '#overlay') {
    return <OverlayApp />
  }

  if (auth === null) return <div className="login-root" />
  if (auth.status === 'loggedOut') {
    // 登录/注册/游客成功后重载渲染层：清空所有 zustand store，避免账号间数据串显
    return <LoginPage onDone={() => window.location.reload()} />
  }

  const renderPage = (): JSX.Element => {
    switch (page) {
      case 'home':
        return <HomePage onNavigate={(p) => setPage(p)} />
      case 'tasks':
        return <TasksPage />
      case 'focus':
        return <FocusPage />
      case 'english':
        return <EnglishModePageWithNoise />
      case 'bili':
        return <BiliModePage />
      case 'stats':
        return <StatsPage />
      case 'notes':
        return <NotesPage />
      case 'settings':
        return <SettingsPage />
    }
  }

  return (
    <div className={`window-container ${isMaximized ? 'is-maximized' : ''}`}>
      <CustomTitlebar
        isMaximized={isMaximized}
        onMinimize={handleMinimize}
        onToggleMaximize={handleToggleMaximize}
        onClose={handleClose}
      />
      <Layout className="app-shell">
        <Sider
          collapsible
          trigger={null}
          collapsed={siderCollapsed}
          collapsedWidth={56}
          width={240}
          breakpoint="md"
          onCollapse={setSiderCollapsed}
          onBreakpoint={(broken) => setSiderCollapsed(broken)}
          className="app-sider"
        >
          <div className="app-sider-inner">
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[page]}
            items={NAV_ITEMS}
            onClick={({ key }) => setPage(key as PageKey)}
            className="app-menu"
          />
          <div className="app-sider-bottom">
            <div
              className="app-collapse-btn"
              role="button"
              tabIndex={0}
              onClick={() => setSiderCollapsed((v) => !v)}
            >
              {siderCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              <span className="app-collapse-text">收起侧栏</span>
            </div>
            <AccountMenu
              auth={auth}
              active={page === 'settings'}
              onOpenSettings={() => setPage('settings')}
            />
          </div>
          </div>
        </Sider>
        <Content className="app-content">
          {/* key=page：切换页面时重挂载滚动区，重置滚动位置并重新计算滚动条——
              否则旧页面的滚动位置/滚动条指标会残留到新页面（非可滑动页出现幽灵滑块或滑块消失） */}
          <ScrollArea key={page} style={{ height: '100%' }}>
            {renderPage()}
          </ScrollArea>
        </Content>
      </Layout>

      <Modal
        title="🔓 紧急退出"
        open={emergencyOpen}
        onOk={() => void handleEmergencyExit()}
        onCancel={() => setEmergencyOpen(false)}
        okText="验证并退出"
        cancelText="取消"
        confirmLoading={emergencyBusy}
        maskClosable={false}
        // 紧急退出弹窗在强制会话（含全屏）中高频出现：按视口比例流体缩放
        rootClassName="app-fluid-modal"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          输入紧急恢复码以解除当前强制会话（错误 3 次将冷却 1 分钟；L2 级别额外冷却 30 秒）。
        </Typography.Paragraph>
        <Input.Password
          autoFocus
          value={emergencyCode}
          placeholder="紧急恢复码"
          onChange={(e) => setEmergencyCode(e.target.value)}
          onPressEnter={() => void handleEmergencyExit()}
        />
        {emergencyHint && (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {emergencyHint}
          </Typography.Text>
        )}
      </Modal>
    </div>
  )
}

export default App
