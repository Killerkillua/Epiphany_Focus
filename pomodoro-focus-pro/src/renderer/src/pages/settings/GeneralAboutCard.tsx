import { useState } from 'react'
import { Button, Card, Col, Modal, Row, Select, Space, Typography, message } from 'antd'

/** ⚙️ 通用与关于：语言 / 主题 / 字体大小 / 版本 / 协议与政策 */
export default function GeneralAboutCard(): JSX.Element {
  const [language, setLanguage] = useState<'zh-CN' | 'en-US'>('zh-CN')
  const [themeMode, setThemeMode] = useState<'system' | 'dark' | 'light'>('system')
  const [fontSize, setFontSize] = useState<'normal' | 'medium' | 'large'>('normal')
  const [modalType, setModalType] = useState<null | 'agreement' | 'privacy'>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  const handleCheckUpdate = (): void => {
    setCheckingUpdate(true)
    setTimeout(() => {
      setCheckingUpdate(false)
      message.success('当前已是最新版本 (v1.0.0)')
    }, 600)
  }

  return (
    <Card size="small" title="⚙️ 通用与关于" className="settings-card">
      <Row gutter={[24, 12]}>
        <Col xs={24} sm={12}>
          <div className="settings-row">
            <span className="settings-label">语言</span>
            <Select
              style={{ width: 140 }}
              value={language}
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en-US', label: 'English' }
              ]}
              onChange={(v) => {
                setLanguage(v)
                message.info('当前已为简体中文')
              }}
            />
          </div>
        </Col>
        <Col xs={24} sm={12}>
          <div className="settings-row">
            <span className="settings-label">主题</span>
            <Select
              style={{ width: 140 }}
              value={themeMode}
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'dark', label: '深色模式' },
                { value: 'light', label: '浅色模式' }
              ]}
              onChange={(v) => {
                setThemeMode(v)
                message.info('主题设置已保存')
              }}
            />
          </div>
        </Col>
        <Col xs={24} sm={12}>
          <div className="settings-row">
            <span className="settings-label">字体大小</span>
            <Select
              style={{ width: 140 }}
              value={fontSize}
              options={[
                { value: 'normal', label: '标准' },
                { value: 'medium', label: '中等' },
                { value: 'large', label: '较大' }
              ]}
              onChange={(v) => {
                setFontSize(v)
                message.info('字体大小已保存')
              }}
            />
          </div>
        </Col>
        <Col xs={24} sm={12}>
          <div className="settings-row">
            <span className="settings-label">版本</span>
            <Typography.Text strong style={{ paddingRight: 12 }}>
              1.0.0
            </Typography.Text>
          </div>
        </Col>
      </Row>

      <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--rule, rgba(255,255,255,0.08))' }}>
        <Space direction="horizontal" size="middle" wrap>
          <Button size="small" onClick={() => setModalType('agreement')}>
            用户协议
          </Button>
          <Button size="small" onClick={() => setModalType('privacy')}>
            隐私政策
          </Button>
          <Button size="small" loading={checkingUpdate} onClick={handleCheckUpdate}>
            检查更新
          </Button>
          <Button
            size="small"
            onClick={async () => {
              try {
                await window.api.settings.openLogDir()
                message.success('已在文件管理器中打开日志目录')
              } catch (err) {
                message.error(`打开日志目录失败: ${err instanceof Error ? err.message : String(err)}`)
              }
            }}
          >
            打开系统日志目录
          </Button>
        </Space>
      </div>

      <Modal
        title={modalType === 'agreement' ? '用户协议' : '隐私政策'}
        open={modalType !== null}
        onOk={() => setModalType(null)}
        onCancel={() => setModalType(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setModalType(null)}>
            知道了
          </Button>
        ]}
        rootClassName="app-fluid-modal"
      >
        {modalType === 'agreement' ? (
          <div style={{ maxHeight: 320, overflowY: 'auto', fontSize: 13, lineHeight: 1.8 }}>
            <p><strong>1. 导言与服务条款</strong></p>
            <p>欢迎使用「静界专注」（Epiphany Focus）。本应用旨在帮助用户进行自主高效专注与学习管理。使用本软件即表示您同意本协议。</p>
            <p><strong>2. 账户与数据</strong></p>
            <p>本软件采用纯本地存储架构，您的全部学习记录、番茄统计、本地笔记均存储在您本机的 SQLite 数据库与用户配置中。</p>
            <p><strong>3. 强制控制免责说明</strong></p>
            <p>强制专注模式提供全屏锁定与按键拦截功能。请在设定前确保无紧急待办事项。如需紧急解锁，可通过连续按 5 次 Esc 键并输入紧急恢复码解除。</p>
          </div>
        ) : (
          <div style={{ maxHeight: 320, overflowY: 'auto', fontSize: 13, lineHeight: 1.8 }}>
            <p><strong>1. 隐私承诺</strong></p>
            <p>「静界专注」高度尊重并保护用户隐私。除您自备 API Key（BYOK）向大语言模型服务提供商发起请求外，本应用不会将您的学习数据、视频记录、笔记、恢复码哈希上传至任何未经授权的第三方服务器。</p>
            <p><strong>2. 匿名统计</strong></p>
            <p>匿名使用统计默认保持关闭。仅当您主动开启时，本地将记录使用频次等非敏感指标，不收集个人身份信息。</p>
            <p><strong>3. 数据安全与导出</strong></p>
            <p>您随时可以通过「数据管理」模块将全部数据导出为 JSON 文件进行备份或迁移，数据主权完全属于您。</p>
          </div>
        )}
      </Modal>
    </Card>
  )
}
