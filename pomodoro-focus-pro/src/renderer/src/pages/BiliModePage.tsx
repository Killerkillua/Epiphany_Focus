import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  message
} from 'antd'
import {
  CloseOutlined,
  FullscreenOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SearchOutlined
} from '@ant-design/icons'
import CoverImage from '../components/CoverImage'
import SessionTimerBar from '../components/SessionTimerBar'
import FeedbackDialog from '../components/FeedbackDialog'
import { useSessionStore } from '../store/sessionStore'
import type { BiliOrder, BiliVideoItem, OverlaySnapshot } from '../../../shared/bili'

/**
 * B 站学习模式页（核心版）：
 * - WBI 签名搜索（关键词 + 排序），结果网格展示
 * - 点击视频自动全屏打开（可配开关，localStorage 持久化）
 * - 订阅主进程事件：导航拦截提示 / 视频窗口开关
 */

const ORDER_OPTIONS = [
  { value: 'totalrank', label: '综合排序' },
  { value: 'click', label: '最多播放' },
  { value: 'pubdate', label: '最新发布' }
]

/** 播放量 / 弹幕数格式化：1.2万 / 3.4亿 */
function formatCount(value: number): string {
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`
  return String(value)
}

function formatDate(timestamp: number): string {
  if (!timestamp) return ''
  const d = new Date(timestamp * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function BiliModePage(): JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [order, setOrder] = useState<BiliOrder>('totalrank')
  const [autoFullscreen, setAutoFullscreen] = useState<boolean>(() => {
    const saved = localStorage.getItem('bili.autoFullscreen')
    return saved === null ? true : saved === '1'
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [items, setItems] = useState<BiliVideoItem[]>([])
  const [searched, setSearched] = useState(false)
  const searchingRef = useRef(false)
  /** 是否有视频窗口正在播放（用于显示"结束学习会话"退出浮层） */
  const [videoOpen, setVideoOpen] = useState(false)
  /** 悬浮面板是否可见（hidden / minimized 视为隐藏；BiliModePage 兜底按钮的显示状态） */
  const [overlayVisible, setOverlayVisible] = useState(true)
  /** 反馈弹窗（R-1） */
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  const persistAutoFullscreen = (value: boolean): void => {
    setAutoFullscreen(value)
    localStorage.setItem('bili.autoFullscreen', value ? '1' : '0')
  }

  const doSearch = useCallback(
    async (targetKeyword: string, targetOrder: BiliOrder): Promise<void> => {
      const kw = targetKeyword.trim()
      if (!kw) {
        message.warning('请输入学习主题关键词')
        return
      }
      if (searchingRef.current) return
      searchingRef.current = true
      setLoading(true)
      setError('')
      try {
        const resp = await window.api.bili.search(kw, { order: targetOrder, page: 1 })
        setItems(resp.items)
        setSearched(true)
        if (resp.items.length === 0) {
          message.info('未找到相关视频，换个关键词试试')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        setItems([])
      } finally {
        searchingRef.current = false
        setLoading(false)
      }
    },
    []
  )

  const handleSearch = (): void => {
    void doSearch(keyword, order)
  }

  const handleOpenVideo = (item: BiliVideoItem): void => {
    // 会话上限时长：取当前学习会话的计划时长（首页时长浮层 / 计时条预设；未开始时为默认快照值），
    // 修复此前未传 plannedMs 导致视频强制会话 cap=0 的问题
    const plannedMs = useSessionStore.getState().snapshot.durationMs
    void window.api.bili
      .openVideo({
        bvid: item.bvid,
        autoFullscreen,
        topic: keyword.trim() || undefined,
        title: item.title, // I-2：标题快照注入 AI 上下文 / 笔记归档 / 进度记录
        plannedMs
      })
      .then(() => {
        message.success(`已打开 ${item.title}（${autoFullscreen ? '全屏' : '窗口'}播放）`)
      })
      .catch((err) => {
        message.error(`打开视频失败: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  // 订阅主进程事件：导航拦截 / 视频窗口开关
  useEffect(() => {
    const offBlocked = window.api.on<{ reason: string; url: string; level: string; category?: string }>(
      window.api.events.bili.navBlocked,
      (verdict) => {
        const cat = verdict.category ? `「${verdict.category}」` : ''
        message.warning(`导航已拦截（${verdict.level}）: ${cat}${verdict.reason}`, 4)
      }
    )
    const offOpened = window.api.on<{ open: boolean }>(window.api.events.bili.videoOpened, () => {
      setVideoOpen(true)
    })
    const offClosed = window.api.on<{ bvid: string }>(window.api.events.bili.videoClosed, () => {
      setVideoOpen(false)
      setOverlayVisible(true)
      message.info('视频窗口已关闭')
    })
    return () => {
      offBlocked()
      offOpened()
      offClosed()
    }
  }, [])

  // 悬浮面板显隐状态同步（面板隐藏后的 UI 兜底：不依赖快捷键即可呼出）
  useEffect(() => {
    if (!videoOpen) return
    const sync = (s: OverlaySnapshot): void => {
      setOverlayVisible(s.state !== 'hidden' && s.state !== 'minimized')
    }
    void window.api.bili
      .overlayGetState()
      .then(sync)
      .catch((err) => console.error('[bili] 获取悬浮面板状态失败:', err))
    const off = window.api.on<OverlaySnapshot>(window.api.events.bili.overlayStateChanged, sync)
    return off
  }, [videoOpen])

  const handleCloseVideo = (): void => {
    void window.api.bili
      .closeVideo()
      .catch((err) => message.error(`关闭视频失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  // 学习助手显示 / 隐藏切换（overlayToggleHide 已由 preload 桥接；快捷键失败时此按钮为兜底入口）
  const handleToggleOverlay = (): void => {
    void window.api.bili
      .overlayToggleHide()
      .catch((err) => message.error(`切换失败: ${err instanceof Error ? err.message : String(err)}`))
  }

  return (
    <div className="page-dashboard">
      <div className="bili-page-head">
        <div>
          <h1 className="page-title">B 站学习模式</h1>
          <p className="page-sub">
            输入学习主题 → WBI 签名搜索 → 结果网格 → 点击视频自动全屏；全屏时右侧悬浮 AI 助手与记事本（可折叠）。
          </p>
        </div>
        {/* R-1 轻量反馈入口 */}
        <Button icon={<MessageOutlined />} onClick={() => setFeedbackOpen(true)}>
          反馈
        </Button>
      </div>

      {/* 视频播放期间的紧急退出浮层（全屏锁定时被视频窗口遮挡，窗口/非全屏播放时始终可见）。
          含"学习助手"显隐兜底按钮：面板 hidden 且快捷键注册失败时，这里是不依赖快捷键的恢复入口 */}
      {videoOpen && (
        <div className="bili-exit-float">
          <div className="bili-overlay-controls">
            <Button
              type={overlayVisible ? 'primary' : 'default'}
              ghost={overlayVisible}
              icon={<RobotOutlined />}
              onClick={handleToggleOverlay}
            >
              学习助手{overlayVisible ? '' : '（已隐藏）'}
            </Button>
            <Button danger type="primary" icon={<CloseOutlined />} onClick={handleCloseVideo}>
              结束学习会话（Ctrl+Shift+Q）
            </Button>
          </div>
        </div>
      )}

      {/* 学习会话计时（倒计时 + 进度 + 到点自动关视频休息） */}
      <SessionTimerBar mode="bili" />

      {/* 搜索区 */}
      <div className="bili-search-bar">
        <Input
          className="bili-search-input"
          placeholder="输入学习主题，如：Python 教程"
          value={keyword}
          allowClear
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={handleSearch}
          prefix={<SearchOutlined />}
        />
        <Select
          className="bili-order-select"
          value={order}
          options={ORDER_OPTIONS}
          onChange={(value) => setOrder(value as BiliOrder)}
        />
        <Space size={4} className="bili-fullscreen-toggle">
          <FullscreenOutlined style={{ color: 'var(--muted)' }} />
          <Switch size="small" checked={autoFullscreen} onChange={persistAutoFullscreen} />
          <span className="bili-toggle-label">自动全屏</span>
        </Space>
        <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={handleSearch}>
          搜索
        </Button>
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          className="bili-alert"
          message="搜索失败"
          description={`${error}。若为 WBI 密钥问题，可稍后重试；网络代理需可直连 api.bilibili.com。`}
        />
      )}

      {/* 结果网格 */}
      {loading ? (
        <div className="bili-loading">
          <Spin tip="搜索中…" />
        </div>
      ) : searched && items.length === 0 && !error ? (
        <Empty description="没有找到相关视频" />
      ) : (
        <div className="bili-grid">
          {items.map((item) => (
            <div
              key={item.bvid}
              className="bili-card"
              role="button"
              tabIndex={0}
              onClick={() => handleOpenVideo(item)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleOpenVideo(item)
              }}
            >
              <div className="bili-card-cover-wrap">
                <CoverImage src={item.picProxied || item.pic} fallbackSrc={item.pic} alt={item.title} />
                {item.duration && <span className="bili-card-duration">{item.duration}</span>}
                <span className="bili-card-play">
                  <PlayCircleOutlined /> {formatCount(item.play)}
                </span>
              </div>
              <div className="bili-card-body">
                <div className="bili-card-title" title={item.title}>
                  {item.title}
                </div>
                <div className="bili-card-meta">
                  <span className="bili-card-author" title={item.author}>
                    {item.author}
                  </span>
                  <span className="bili-card-date">{formatDate(item.pubdate)}</span>
                </div>
                <div className="bili-card-tags">
                  <Tag className="bili-tag">{item.bvid}</Tag>
                  <Tag className="bili-tag">弹幕 {formatCount(item.danmaku)}</Tag>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {searched && items.length > 0 && (
        <div className="bili-hint">
          <FullscreenOutlined /> 自动全屏已{autoFullscreen ? '开启' : '关闭'}
          {autoFullscreen
            ? '：点击视频将全屏锁定播放（Esc/F11 无效；按 Ctrl+Shift+Q 或悬浮面板「关闭视频」退出）'
            : '：点击视频以普通窗口播放'}
        </div>
      )}

      <FeedbackDialog open={feedbackOpen} mode="bili" onClose={() => setFeedbackOpen(false)} />
    </div>
  )
}

export default BiliModePage
