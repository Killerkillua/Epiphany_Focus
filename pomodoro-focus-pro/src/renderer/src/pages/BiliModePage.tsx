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
import { FullscreenOutlined, PlayCircleOutlined, SearchOutlined } from '@ant-design/icons'
import type { BiliOrder, BiliVideoItem } from '../../../shared/bili'

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
    void window.api.bili
      .openVideo({
        bvid: item.bvid,
        autoFullscreen,
        topic: keyword.trim() || undefined
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
    const offClosed = window.api.on<{ bvid: string }>(window.api.events.bili.videoClosed, () => {
      message.info('视频窗口已关闭')
    })
    return () => {
      offBlocked()
      offClosed()
    }
  }, [])

  return (
    <div>
      <h1 className="page-title">B 站学习模式</h1>
      <p className="page-sub">
        输入学习主题 → WBI 签名搜索 → 结果网格 → 点击视频自动全屏；全屏时右侧悬浮 AI 助手与记事本（可折叠）。
      </p>

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
              <div className="bili-card-cover">
                <img src={item.pic} alt={item.title} loading="lazy" />
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
          {autoFullscreen ? '：点击视频将全屏锁定播放（Esc/F11/缩小均无效）' : '：点击视频以普通窗口播放'}
        </div>
      )}
    </div>
  )
}

export default BiliModePage
