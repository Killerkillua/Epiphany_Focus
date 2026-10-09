import { useEffect, useState } from 'react'
import { Button, Card, Input, List, Space, Switch, Tag, message } from 'antd'
import {
  describeSiteRule,
  draftSiteRuleFromText,
  sameSiteRule,
  type LearningSiteRule
} from '../../../../shared/study'

/** 自定义学习网站：域名 + 可选路径前缀。B 站相关度仍在视频学习卡片中配置。 */
export default function LearningSitesCard(): JSX.Element {
  const [sites, setSites] = useState<LearningSiteRule[]>([])
  const [host, setHost] = useState('')
  const [prefix, setPrefix] = useState('')
  const [label, setLabel] = useState('')
  const [preview, setPreview] = useState('')
  const [saving, setSaving] = useState(false)

  const load = (): void => {
    void window.api.settings
      .get()
      .then((settings) => setSites(settings.learning?.sites ?? []))
      .catch(() => setSites([]))
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    if (!host.trim()) {
      setPreview('')
      return
    }
    const draft = draftSiteRuleFromText(host, prefix.trim() ? [prefix] : [], label)
    setPreview(draft.ok ? draft.summary : (draft.error ?? ''))
  }, [host, prefix, label])

  const persist = async (next: LearningSiteRule[], tip: string): Promise<void> => {
    setSaving(true)
    try {
      await window.api.settings.set({ 'learning.sites': next })
      setSites(next)
      message.success(tip)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const add = (): void => {
    const draft = draftSiteRuleFromText(host, prefix.trim() ? [prefix] : [], label)
    if (!draft.ok || !draft.rule) {
      message.error(draft.error ?? '规则无效')
      return
    }
    if (sites.some((site) => sameSiteRule(site, draft.rule!))) {
      message.warning('这条规则已经存在')
      return
    }
    void persist([...sites, draft.rule], '已添加学习网站').then(() => {
      setHost('')
      setPrefix('')
      setLabel('')
    })
  }

  return (
    <Card size="small" title="学习网站白名单" className="settings-card">
      <p className="page-sub">
        允许在专注窗口中访问指定域名。路径前缀留空表示放行该主机的全部页面。白名单不是网站安全背书。
      </p>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Input
          placeholder="域名或网址，如 github.com、https://leetcode.cn/problems"
          value={host}
          disabled={saving}
          onChange={(e) => setHost(e.target.value)}
        />
        <Input
          placeholder="可选路径前缀，如 /problems"
          value={prefix}
          disabled={saving}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <Input
          placeholder="显示名称（可选）"
          value={label}
          disabled={saving}
          onChange={(e) => setLabel(e.target.value)}
        />
        {preview && <div className="page-sub">{preview}</div>}
        <Button type="primary" disabled={saving || !host.trim()} onClick={add}>
          添加
        </Button>
      </Space>
      <List
        style={{ marginTop: 12 }}
        locale={{ emptyText: '尚未添加学习网站' }}
        dataSource={sites}
        renderItem={(site) => (
          <List.Item
            actions={[
              <Switch
                key="enabled"
                checked={site.enabled}
                disabled={saving}
                onChange={(enabled) => {
                  void persist(
                    sites.map((item) => (item.id === site.id ? { ...item, enabled } : item)),
                    enabled ? '已启用' : '已停用'
                  )
                }}
              />,
              <Button
                key="remove"
                type="link"
                danger
                disabled={saving}
                onClick={() => {
                  void persist(
                    sites.filter((item) => item.id !== site.id),
                    '已删除'
                  )
                }}
              >
                删除
              </Button>
            ]}
          >
            <List.Item.Meta
              title={
                <span>
                  {site.label || site.host} <Tag>{site.includeSubdomains ? '含子域' : '仅此主机'}</Tag>
                </span>
              }
              description={describeSiteRule(site)}
            />
          </List.Item>
        )}
      />
    </Card>
  )
}
