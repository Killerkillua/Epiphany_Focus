import { useEffect, useState } from 'react'
import { Alert, Button, Card, Checkbox, Form, Input, Modal, Typography, message } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import type { AuthState } from '../../../../shared/auth'

/** ⚠️ 危险操作：退出登录 / 删除账号 */
export default function DangerZoneCard(): JSX.Element | null {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form] = Form.useForm()

  useEffect(() => {
    void window.api.auth.getState().then(setAuth)
  }, [])

  if (!auth || auth.status === 'loggedOut') return null

  const isGuest = auth.status === 'guest'

  const doLogout = async (): Promise<void> => {
    await window.api.auth.logout()
    window.location.reload()
  }

  const handleLogout = (): void => {
    Modal.confirm({
      title: isGuest ? '退出游客模式？' : '退出登录？',
      icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
      content: isGuest
        ? '游客数据会保留在本机游客空间，下次可再次以游客身份进入。'
        : '退出后可重新登录或切换其它账号。',
      okText: isGuest ? '退出游客并去登录' : '退出登录',
      cancelText: '取消',
      onOk: doLogout
    })
  }

  const handleDeleteAccount = async (): Promise<void> => {
    try {
      const v = await form.validateFields()
      setBusy(true)
      setError('')
      const r = await window.api.auth.deleteAccount({
        password: v.password,
        deleteData: !!v.deleteData
      })
      if (!r.ok) {
        setError(r.error ?? '注销失败')
        return
      }
      message.success('账号已注销')
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      size="small"
      title={
        <span style={{ color: 'var(--red, #f87171)' }}>
          ⚠️ 危险操作
        </span>
      }
      className="settings-card settings-danger-card"
    >
      <div className="settings-row" style={{ justifyContent: 'space-between' }}>
        <Button onClick={handleLogout}>
          {isGuest ? '退出游客模式' : '退出登录'}
        </Button>
        <Button
          danger
          type="primary"
          disabled={isGuest}
          onClick={() => {
            setError('')
            form.resetFields()
            setDeleteOpen(true)
          }}
          title={isGuest ? '游客模式无需注销' : undefined}
        >
          删除账号
        </Button>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
        退出登录可返回登录页面切换账号；删除账号将注销当前账号，并可选择是否清除本地学习数据。
      </Typography.Text>

      <Modal
        title="注销账号"
        open={deleteOpen}
        onCancel={() => {
          setDeleteOpen(false)
          setError('')
          form.resetFields()
        }}
        onOk={() => void handleDeleteAccount()}
        confirmLoading={busy}
        okText="确认注销"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        destroyOnClose
        rootClassName="app-fluid-modal"
      >
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="注销后该账号将无法登录，请谨慎操作。"
        />
        <Form form={form} layout="vertical">
          <Form.Item
            name="password"
            label="输入密码确认"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoFocus placeholder="请输入当前账号密码" />
          </Form.Item>
          <Form.Item name="deleteData" valuePropName="checked" initialValue={false}>
            <Checkbox>同时永久删除该账号的全部本地数据（专注记录、笔记、生词等）</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
