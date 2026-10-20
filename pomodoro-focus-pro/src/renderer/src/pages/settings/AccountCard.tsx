import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input, Modal, Typography, message } from 'antd'
import {
  AUTH_RULES,
  validateNickname,
  validatePassword,
  type AuthState
} from '../../../../shared/auth'

type Dialog = null | 'nickname' | 'password'

/** 👤 账号与安全：昵称 / 修改密码；游客显示升级提示 */
export default function AccountCard(): JSX.Element | null {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form] = Form.useForm()

  useEffect(() => {
    void window.api.auth.getState().then(setAuth)
  }, [])

  if (!auth || auth.status === 'loggedOut') return null

  const close = (): void => {
    setDialog(null)
    setError('')
    form.resetFields()
  }

  const leaveToLogin = async (): Promise<void> => {
    await window.api.auth.logout()
    window.location.reload()
  }

  if (auth.status === 'guest') {
    return (
      <Card size="small" title="👤 账号与安全" className="settings-card">
        <div style={{ marginBottom: 14 }}>
          <Typography.Title level={5} style={{ margin: '0 0 6px 0', fontSize: 14 }}>
            当前为游客模式
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13, lineHeight: 1.6, display: 'block' }}>
            游客数据保存在本机游客空间。注册账号后可拥有独立的数据空间，并支持自动登录。
          </Typography.Text>
        </div>
        <Button type="primary" onClick={() => void leaveToLogin()}>
          去登录 / 注册
        </Button>
      </Card>
    )
  }

  const user = auth.user

  const submit = async (): Promise<void> => {
    const v = await form.validateFields()
    setBusy(true)
    setError('')
    try {
      if (dialog === 'nickname') {
        const r = await window.api.auth.updateNickname(v.nickname ?? '')
        if (!r.ok) return setError(r.error)
        setAuth({ status: 'user', user: r.user })
        message.success('昵称已更新')
        close()
      } else if (dialog === 'password') {
        const r = await window.api.auth.changePassword(v.oldPassword, v.newPassword)
        if (!r.ok) return setError(r.error)
        message.success('密码已修改，自动登录已重置')
        close()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败')
    } finally {
      setBusy(false)
    }
  }

  const titles: Record<Exclude<Dialog, null>, string> = {
    nickname: '修改昵称',
    password: '修改密码'
  }

  return (
    <Card size="small" title="👤 账号与安全" className="settings-card">
      <div className="settings-row">
        <span className="settings-label">用户名</span>
        <Typography.Text>{user.username}</Typography.Text>
      </div>
      <div className="settings-row">
        <span className="settings-label">昵称</span>
        <span>
          <Typography.Text style={{ marginRight: 12 }}>{user.nickname}</Typography.Text>
          <Button size="small" onClick={() => setDialog('nickname')}>
            修改
          </Button>
        </span>
      </div>
      <div className="settings-row">
        <span className="settings-label">登录密码</span>
        <Button size="small" onClick={() => setDialog('password')}>
          修改密码
        </Button>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
        账号与数据仅保存在本机；忘记密码时可用注册时保存的恢复码重置。
      </Typography.Text>

      <Modal
        title={dialog ? titles[dialog] : ''}
        open={dialog !== null}
        onCancel={close}
        onOk={() => void submit()}
        confirmLoading={busy}
        okText="确定"
        cancelText="取消"
        destroyOnClose
        rootClassName="app-fluid-modal"
      >
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" initialValues={{ nickname: user.nickname }}>
          {dialog === 'nickname' && (
            <Form.Item
              name="nickname"
              label="昵称（留空则使用用户名）"
              rules={[
                {
                  validator: (_, v: string) => {
                    const msg = validateNickname(v ?? '')
                    return msg ? Promise.reject(new Error(msg)) : Promise.resolve()
                  }
                }
              ]}
            >
              <Input maxLength={AUTH_RULES.nicknameMax} autoFocus />
            </Form.Item>
          )}
          {dialog === 'password' && (
            <>
              <Form.Item
                name="oldPassword"
                label="原密码"
                rules={[{ required: true, message: '请输入原密码' }]}
              >
                <Input.Password autoFocus />
              </Form.Item>
              <Form.Item
                name="newPassword"
                label="新密码"
                rules={[
                  {
                    validator: (_, v: string) => {
                      const msg = validatePassword(v ?? '')
                      return msg ? Promise.reject(new Error(msg)) : Promise.resolve()
                    }
                  }
                ]}
              >
                <Input.Password />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="确认新密码"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: '请再次输入新密码' },
                  ({ getFieldValue }) => ({
                    validator: (_, v: string) =>
                      !v || getFieldValue('newPassword') === v
                        ? Promise.resolve()
                        : Promise.reject(new Error('两次输入的密码不一致'))
                  })
                ]}
              >
                <Input.Password />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </Card>
  )
}
