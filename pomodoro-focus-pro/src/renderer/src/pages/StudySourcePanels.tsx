import { useEffect, useState } from 'react'
import { Alert, Button, Input, List, Space, Tag, message } from 'antd'
import { FolderOpenOutlined, LinkOutlined } from '@ant-design/icons'
import { useSessionStore } from '../store/sessionStore'
import { describeSiteRule, type LearningSiteRule } from '../../../shared/study'

interface StudySourcePanelsProps {
  tab: 'local' | 'web'
  autoFullscreen: boolean
  topic?: string
}

/** 本地视频与白名单网站入口。B 站搜索失败不影响这里。 */
export default function StudySourcePanels({
  tab,
  autoFullscreen,
  topic
}: StudySourcePanelsProps): JSX.Element {
  const [url, setUrl] = useState('')
  const [sites, setSites] = useState<LearningSiteRule[]>([])
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    if (tab !== 'web') return
    void window.api.settings
      .get()
      .then((settings) => setSites((settings.learning?.sites ?? []).filter((site) => site.enabled)))
      .catch(() => setSites([]))
  }, [tab])

  const openLocal = (): void => {
    setOpening(true)
    void window.api.study
      .pickLocal()
      .then(async (picked) => {
        if (picked.canceled || !picked.token || !picked.resourceKey || !picked.title) return
        if (picked.warning) message.warning(picked.warning, 6)
        const plannedMs = useSessionStore.getState().snapshot.durationMs
        await window.api.study.openLocal({
          token: picked.token,
          resourceKey: picked.resourceKey,
          title: picked.title,
          autoFullscreen,
          topic,
          plannedMs
        })
        message.success(`已打开 ${picked.title}`)
      })
      .catch((err) => {
        message.error(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setOpening(false))
  }

  const openWeb = (target: string, label?: string): void => {
    const trimmed = target.trim()
    if (!trimmed) {
      message.warning('请输入学习网站地址')
      return
    }
    setOpening(true)
    const plannedMs = useSessionStore.getState().snapshot.durationMs
    void window.api.study
      .openWeb({ url: trimmed, autoFullscreen, topic, plannedMs, label })
      .then(() => message.success('已在专注窗口打开学习网站'))
      .catch((err) => message.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setOpening(false))
  }

  if (tab === 'local') {
    return (
      <div className="bili-search-bar" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Button
            type="primary"
            icon={<FolderOpenOutlined />}
            loading={opening}
            onClick={openLocal}
          >
            选择本地视频
          </Button>
          <p className="page-sub" style={{ marginTop: 12 }}>
            稳定支持常见 H.264/AAC MP4。MKV / FLV 可以选择，但若无法播放，需要先转封装或转换为 MP4。
            播放、全屏锁定、笔记打点和续播都留在专注窗口内。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <Space.Compact style={{ width: '100%', maxWidth: 720 }}>
        <Input
          placeholder="https://leetcode.cn/problems"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPressEnter={() => openWeb(url)}
          prefix={<LinkOutlined />}
        />
        <Button type="primary" loading={opening} onClick={() => openWeb(url)}>
          打开
        </Button>
      </Space.Compact>
      <Alert
        style={{ marginTop: 12 }}
        type="info"
        showIcon
        message="只打开已加入白名单的域名和路径。登录状态会保留在独立的学习窗口里。"
      />
      <List
        style={{ marginTop: 16, maxWidth: 720 }}
        locale={{ emptyText: '还没有启用的学习网站。请先到设置里添加域名。' }}
        dataSource={sites}
        renderItem={(site) => (
          <List.Item
            actions={[
              <Button key="open" type="link" onClick={() => openWeb(`https://${site.host}${site.pathPrefixes[0] ?? ''}`, site.label)}>
                打开
              </Button>
            ]}
          >
            <List.Item.Meta
              title={site.label || site.host}
              description={
                <span>
                  <Tag>{site.host}</Tag>
                  {describeSiteRule(site)}
                </span>
              }
            />
          </List.Item>
        )}
      />
    </div>
  )
}
