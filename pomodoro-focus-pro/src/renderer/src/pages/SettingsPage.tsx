import { useEffect, useMemo, useRef, useState } from 'react'
import { Divider, Empty, Input, Tag } from 'antd'
import type { InputRef } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useSettingsLoader } from './settings/useSettingsLoader'
import AccountCard from './settings/AccountCard'
import AiSettingsCard from './settings/AiSettingsCard'
import EnforcementCard from './settings/EnforcementCard'
import PomodoroCard from './settings/PomodoroCard'
import BiliCard from './settings/BiliCard'
import LearningSitesCard from './settings/LearningSitesCard'
import StudySessionCard from './settings/StudySessionCard'
import NoiseCard from './settings/NoiseCard'
import DataManagementCard from './settings/DataManagementCard'
import HelpImproveCard from './settings/HelpImproveCard'
import GeneralAboutCard from './settings/GeneralAboutCard'
import DangerZoneCard from './settings/DangerZoneCard'

/**
 * 设置页（方案 4.2 重构）：单列全宽布局，一个模块占据一行。
 * 支持顶部搜索过滤设置项（快捷键 Ctrl+K / Cmd+K）。
 */
export default function SettingsPage(): JSX.Element {
  const { form, setForm, saving, backups, load, refreshBackups, update } = useSettingsLoader()
  const [searchKey, setSearchKey] = useState('')
  const searchInputRef = useRef<InputRef>(null)

  // 快捷键 Ctrl+K 或 Cmd+K 聚焦搜索框
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus({ cursor: 'all' })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const modules = useMemo(() => {
    return [
      {
        id: 'account',
        title: '账号与安全',
        keywords: [
          '账号',
          '安全',
          '游客',
          '登录',
          '注册',
          '昵称',
          '密码',
          '用户名',
          'account',
          'user'
        ],
        component: <AccountCard />
      },
      {
        id: 'ai',
        title: 'AI 设置 (BYOK)',
        keywords: [
          'ai',
          'byok',
          'api',
          'key',
          '端点',
          '对话模型',
          'ocr',
          '单会话上限',
          'qwen',
          'model'
        ],
        component: (
          <AiSettingsCard
            form={form}
            setForm={setForm}
            saving={saving}
            update={update}
            reload={load}
          />
        )
      },
      {
        id: 'enforcement',
        title: '强制控制 (方案 2.5)',
        keywords: [
          '强制',
          '控制',
          '锁定',
          'l0',
          'l1',
          'l2',
          '到点动作',
          '会话上限',
          '恢复码',
          'esc',
          'lock'
        ],
        component: (
          <EnforcementCard form={form} saving={saving} update={update} onCodeSaved={load} />
        )
      },
      {
        id: 'pomodoro',
        title: '番茄钟参数',
        keywords: ['番茄', '专注时长', '短休息', '长休息', '间隔', 'pomodoro', 'timer'],
        component: <PomodoroCard form={form} saving={saving} update={update} />
      },
      {
        id: 'bili',
        title: '视频学习模式',
        keywords: ['视频', '学习', 'bili', 'b站', '相关度', '全屏', 'strictness', 'mp4'],
        component: <BiliCard form={form} saving={saving} update={update} />
      },
      {
        id: 'learning-sites',
        title: '学习网站白名单',
        keywords: ['白名单', '网站', '域名', 'leetcode', 'github', '路径', '学习网站'],
        component: <LearningSitesCard />
      },
      {
        id: 'study-session',
        title: '学习会话',
        keywords: ['学习会话', '全屏遮罩', '英语', '计时', 'session', 'overlay'],
        component: <StudySessionCard form={form} saving={saving} update={update} />
      },
      {
        id: 'noise',
        title: '白噪音',
        keywords: ['白噪音', '音效', '预设', '雨声', '海浪', '咖啡厅', 'noise', 'audio'],
        component: <NoiseCard form={form} saving={saving} update={update} />
      },
      {
        id: 'data-management',
        title: '数据管理 (M5: 本地备份 / 恢复)',
        keywords: [
          '数据',
          '备份',
          '恢复',
          '导出',
          'json',
          '自动备份',
          '频率',
          '保留份数',
          '目录',
          'backup'
        ],
        component: (
          <DataManagementCard
            form={form}
            setForm={setForm}
            saving={saving}
            update={update}
            backups={backups}
            refreshBackups={refreshBackups}
          />
        )
      },
      {
        id: 'help-improve',
        title: '帮助改进 (R-2: 可选匿名统计)',
        keywords: ['帮助', '改进', '匿名', '统计', '反馈', 'telemetry', 'feedback'],
        component: <HelpImproveCard form={form} saving={saving} update={update} />
      },
      {
        id: 'general-about',
        title: '通用与关于',
        keywords: [
          '通用',
          '关于',
          '语言',
          '主题',
          '字体',
          '版本',
          '协议',
          '隐私',
          '更新',
          '开机',
          '自启',
          '托盘',
          'general',
          'about',
          'launch'
        ],
        component: <GeneralAboutCard form={form} saving={saving} update={update} />
      },
      {
        id: 'danger-zone',
        title: '危险操作',
        keywords: [
          '危险',
          '危险操作',
          '退出',
          '退出登录',
          '切换账号',
          '删除账号',
          '注销',
          'logout',
          'delete'
        ],
        component: <DangerZoneCard />
      }
    ]
  }, [form, saving, backups, setForm, update, load, refreshBackups])

  const filteredModules = useMemo(() => {
    const q = searchKey.trim().toLowerCase()
    if (!q) return modules
    return modules.filter((m) => {
      if (m.title.toLowerCase().includes(q)) return true
      return m.keywords.some((k) => k.toLowerCase().includes(q))
    })
  }, [modules, searchKey])

  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent)
  const shortcutHint = isMac ? '⌘K' : 'Ctrl+K'

  return (
    <div className="page-dashboard">
      <h1 className="page-title">账户设置</h1>
      <p className="page-sub">账号信息与全部应用配置，修改即时生效</p>

      <div className="settings-search-bar">
        <Input
          ref={searchInputRef}
          size="middle"
          prefix={<SearchOutlined style={{ color: 'var(--muted, #9ca3af)', marginRight: 6 }} />}
          suffix={<Tag style={{ margin: 0, opacity: 0.85, fontSize: 11 }}>{shortcutHint}</Tag>}
          placeholder="搜索设置... (Ctrl+K)"
          allowClear
          value={searchKey}
          onChange={(e) => setSearchKey(e.target.value)}
          style={{ width: '100%', maxWidth: 420, borderRadius: 6 }}
        />
      </div>

      <Divider
        style={{ margin: '0 0 20px 0', borderColor: 'var(--rule, rgba(255, 255, 255, 0.08))' }}
      />

      <div className="settings-layout">
        {filteredModules.length > 0 ? (
          filteredModules.map((m) => (
            <div key={m.id} style={{ width: '100%' }}>
              {m.component}
            </div>
          ))
        ) : (
          <Empty
            description={`未找到与 "${searchKey}" 相关的设置模块`}
            style={{ margin: '48px 0', color: 'var(--muted)' }}
          />
        )}
      </div>
    </div>
  )
}
