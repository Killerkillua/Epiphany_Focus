import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Empty,
  Input,
  Pagination,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  message
} from 'antd'
import {
  CloseOutlined,
  DownOutlined,
  FullscreenOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SearchOutlined
} from '@ant-design/icons'
import CoverImage from '../components/CoverImage'
import SessionTimerBar from '../components/SessionTimerBar'
import LearningAssistantDrawer from '../components/LearningAssistantDrawer'
import { useSessionStore } from '../store/sessionStore'
import type { BiliOrder, BiliVideoItem, OverlaySnapshot } from '../../../shared/bili'

/**
 * 视频学习模式页（核心版）：
 * - WBI 签名搜索（关键词 + 排序），结果网格展示
 * - 点击视频自动全屏打开（可配开关，localStorage 持久化）
 * - 订阅主进程事件：导航拦截提示 / 视频窗口开关
 */

const ORDER_OPTIONS = [
  { value: 'totalrank', label: '综合排序' },
  { value: 'click', label: '最多播放' },
  { value: 'pubdate', label: '最新发布' }
]

/**
 * 视频学习搜索接口默认每页条数（主进程未传 page_size，视频学习按 20 条/页返回，
 * 并以该粒度计算 numPages）。antd Pagination 用它与 numResults 推算总页数，
 * 必须与 视频学习口径一致，否则页码按钮数与实际页数不符。
 */
const PAGE_SIZE = 20

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
  /** 分页状态（此前缺失：搜索永远 page:1，numPages/numResults 被丢弃） */
  const [page, setPage] = useState(1)
  const [numResults, setNumResults] = useState(0)
  const [numPages, setNumPages] = useState(1)
  const searchingRef = useRef(false)
  /** 结果网格容器（翻页 / 换排序后滚动回结果区顶部） */
  const gridRef = useRef<HTMLDivElement>(null)
  /** 是否有视频窗口正在播放（用于显示"结束学习会话"退出浮层） */
  const [videoOpen, setVideoOpen] = useState(false)
  /** 悬浮面板是否可见（hidden / minimized 视为隐藏；BiliModePage 兜底按钮的显示状态） */
  const [overlayVisible, setOverlayVisible] = useState(true)
  /** 学习助手抽屉（非视频模式入口，问题 3；打开视频时自动关闭与悬浮面板互斥） */
  const [assistantOpen, setAssistantOpen] = useState(false)

  const persistAutoFullscreen = (value: boolean): void => {
    setAutoFullscreen(value)
    localStorage.setItem('bili.autoFullscreen', value ? '1' : '0')
  }

  const doSearch = useCallback(
    async (targetKeyword: string, targetOrder: BiliOrder, targetPage: number): Promise<void> => {
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
        // 分页修复：不再硬编码 page:1，传当前目标页码；消费 resp 返回的分页元数据
        const resp = await window.api.bili.search(kw, { order: targetOrder, page: targetPage })
        setItems(resp.items)
        setNumResults(resp.numResults)
        setNumPages(Math.max(1, resp.numPages))
        setPage(Math.max(1, resp.page))
        setSearched(true)
        if (resp.items.length === 0) {
          message.info(targetPage > 1 ? '该页没有更多内容了' : '未找到相关视频，换个关键词试试')
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
    void doSearch(keyword, order, 1)
  }

  /** 排序切换立即生效：已有搜索结果时自动按新排序从第 1 页重搜（否则只改下拉不刷新，用户会误以为排序无效） */
  const handleOrderChange = (value: BiliOrder): void => {
    setOrder(value)
    if (searched && keyword.trim()) {
      void doSearch(keyword, value, 1)
    }
  }

  /** 翻页 */
  const handlePageChange = (p: number): void => {
    void doSearch(keyword, order, p)
  }

  // 新一页结果就绪后滚回结果区顶部（翻页 / 换排序后不滞留页面底部）
  useEffect(() => {
    if (searched && items.length > 0) {
      gridRef.current?.scrollIntoView({ block: 'start' })
    }
  }, [searched, items])

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
        plannedMs,
        // M2：封面（bili-image:// 代理地址）与 UP 主快照写入进度记录卡片
        coverUrl: item.picProxied || undefined,
        author: item.author || undefined,
        source: 'search'
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
    const offBlocked = window.api.on<{
      reason: string
      url: string
      level: string
      category?: string
    }>(window.api.events.bili.navBlocked, (verdict) => {
      const cat = verdict.category ? `「${verdict.category}」` : ''
      message.warning(`导航已拦截（${verdict.level}）: ${cat}${verdict.reason}`, 4)
    })
    const offOpened = window.api.on<{ open: boolean }>(window.api.events.bili.videoOpened, () => {
      setVideoOpen(true)
      // 打开视频后自动关闭学习助手抽屉（与悬浮面板互斥，避免重复）
      setAssistantOpen(false)
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
      .catch((err) =>
        message.error(`关闭视频失败: ${err instanceof Error ? err.message : String(err)}`)
      )
  }

  // 学习助手显示 / 隐藏切换（overlayToggleHide 已由 preload 桥接；快捷键失败时此按钮为兜底入口）
  const handleToggleOverlay = (): void => {
    void window.api.bili
      .overlayToggleHide()
      .catch((err) =>
        message.error(`切换失败: ${err instanceof Error ? err.message : String(err)}`)
      )
  }

  return (
    <div className="page-dashboard">
      <div className="bili-page-head">
        <div>
          <h1 className="page-title">视频学习模式</h1>
          <p className="page-sub">
            输入学习主题 → WBI 签名搜索 → 结果网格 → 点击视频自动全屏；全屏时右侧悬浮学习助手（对话
            / 笔记 / 进度，可拖拽、最小化）。
          </p>
        </div>
        {/* 问题 3：顶部导航栏右侧"学习助手"入口（非视频模式抽屉；反馈已迁移至设置页） */}
        <Button icon={<RobotOutlined />} onClick={() => setAssistantOpen(true)}>
          学习助手 <DownOutlined style={{ fontSize: 10, opacity: 0.6 }} />
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
          onChange={(value) => handleOrderChange(value as BiliOrder)}
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
          description={`${error}。若为 WBI 密钥问题，可稍后重试；网络代理需可直连视频站点接口。`}
        />
      )}

      {/* 结果统计：总条数 + 当前页码（此前 numResults / numPages 被丢弃，无任何提示） */}
      {searched && items.length > 0 && (
        <div className="bili-result-meta">
          <span>
            共 <b>{numResults.toLocaleString('zh-CN')}</b> 条结果
          </span>
          {numPages > 1 && (
            <span>
              第 {page} / {numPages} 页
            </span>
          )}
        </div>
      )}

      {/* 结果网格 */}
      {loading ? (
        <div className="bili-loading">
          <Spin tip="搜索中…" />
        </div>
      ) : searched && items.length === 0 && !error ? (
        <Empty description="没有找到相关视频" />
      ) : (
        <div ref={gridRef} className="bili-grid">
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
                <CoverImage
                  src={item.picProxied || item.pic}
                  fallbackSrc={item.pic}
                  alt={item.title}
                />
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

      {/* 分页：多于一页时显示（翻页重新请求，page 参数此前被硬编码为 1）。
          total 用 numPages × PAGE_SIZE（视频学习返回的页数口径），
          不用 numResults：numResults 与页数换算可能不同步，导致页码按钮数与实际页数不符 */}
      {searched && items.length > 0 && numPages > 1 && (
        <div className="bili-pagination">
          <Pagination
            current={page}
            total={numPages * PAGE_SIZE}
            pageSize={PAGE_SIZE}
            showSizeChanger={false}
            showQuickJumper
            onChange={handlePageChange}
          />
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

      <LearningAssistantDrawer
        open={assistantOpen}
        topic={keyword.trim() || undefined}
        onClose={() => setAssistantOpen(false)}
      />
    </div>
  )
}

export default BiliModePage
