import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Form, Input, Progress, Tabs, Typography } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import appLogo from '../assets/icon.png'
import RecoveryCodeDialog from '../components/RecoveryCodeDialog'
import {
  AUTH_RULES,
  passwordStrength,
  validateNickname,
  validatePassword,
  validateUsername
} from '../../../shared/auth'

interface LoginPageProps {
  /** 登录 / 注册 / 游客进入成功后回调（外层重新加载应用以刷新各 store） */
  onDone: () => void
}

type View = 'login' | 'register' | 'reset'

const STRENGTH_LABEL = ['太弱', '较弱', '一般', '良好', '很强']
const STRENGTH_COLOR = ['#ff4d4f', '#ff7a45', '#faad14', '#73d13d', '#52c41a']

/** 登录 / 注册 / 忘记密码（恢复码）/ 游客入口 */
export default function LoginPage({ onDone }: LoginPageProps): JSX.Element {
  const [view, setView] = useState<View>('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lockSec, setLockSec] = useState(0)
  const [password, setPassword] = useState('')
  const [recovery, setRecovery] = useState<{ code: string; rotated: boolean; after: View } | null>(
    null
  )

  // 锁定倒计时
  useEffect(() => {
    if (lockSec <= 0) return
    const t = setInterval(() => setLockSec((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [lockSec > 0]) // eslint-disable-line react-hooks/exhaustive-deps

  const switchView = (v: View): void => {
    setView(v)
    setError('')
    setPassword('')
  }

  const handleFail = (r: { error: string; retryInSec?: number }): void => {
    setError(r.error)
    setLockSec(r.retryInSec ?? 0)
  }

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const onLogin = (v: { username: string; password: string; remember?: boolean }): Promise<void> =>
    run(async () => {
      const r = await window.api.auth.login({
        username: v.username,
        password: v.password,
        remember: !!v.remember
      })
      if (r.ok) onDone()
      else handleFail(r)
    })

  const onRegister = (v: { username: string; password: string; nickname?: string }): Promise<void> =>
    run(async () => {
      const r = await window.api.auth.register(v)
      if (r.ok) setRecovery({ code: r.recoveryCode, rotated: false, after: 'login' })
      else handleFail(r)
    })

  const onReset = (v: {
    username: string
    recoveryCode: string
    newPassword: string
  }): Promise<void> =>
    run(async () => {
      const r = await window.api.auth.resetPassword(v)
      if (r.ok) setRecovery({ code: r.recoveryCode, rotated: true, after: 'login' })
      else handleFail(r)
    })

  const onGuest = (): Promise<void> =>
    run(async () => {
      const r = await window.api.auth.loginGuest()
      if (r.ok) onDone()
      else handleFail(r)
    })

  const strength = passwordStrength(password)
  const locked = lockSec > 0
  const errorText = locked
    ? `${error}，请 ${Math.floor(lockSec / 60)}:${String(lockSec % 60).padStart(2, '0')} 后重试`
    : error

  const passwordRule = (_: unknown, value: string): Promise<void> => {
    const msg = validatePassword(value ?? '')
    return msg ? Promise.reject(new Error(msg)) : Promise.resolve()
  }

  return (
    <div className="login-root">
      <div className="login-brand">
        <img src={appLogo} alt="Logo" className="login-brand-logo" />
        <Typography.Title level={2} style={{ margin: '16px 0 4px' }}>
          静界专注
        </Typography.Title>
        <Typography.Text type="secondary">强制专注 · 沉浸学习 · 看见成长</Typography.Text>
      </div>

      <div className="login-card">
        {view !== 'reset' ? (
          <Tabs
            centered
            activeKey={view}
            onChange={(k) => switchView(k as View)}
            items={[
              { key: 'login', label: '登录' },
              { key: 'register', label: '注册' }
            ]}
          />
        ) : (
          <Typography.Title level={4} style={{ textAlign: 'center', marginBottom: 16 }}>
            使用恢复码重置密码
          </Typography.Title>
        )}

        {errorText && (
          <Alert type="error" showIcon message={errorText} style={{ marginBottom: 16 }} />
        )}

        {view === 'login' && (
          <Form layout="vertical" onFinish={(v) => void onLogin(v)} initialValues={{ remember: true }}>
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名" autoFocus maxLength={20} />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" />
            </Form.Item>
            <div className="login-row">
              <Form.Item name="remember" valuePropName="checked" noStyle>
                <Checkbox>记住我（30 天内自动登录）</Checkbox>
              </Form.Item>
              <Button type="link" size="small" onClick={() => switchView('reset')}>
                忘记密码？
              </Button>
            </div>
            <Button type="primary" htmlType="submit" block loading={busy} disabled={locked}>
              登录
            </Button>
          </Form>
        )}

        {view === 'register' && (
          <Form layout="vertical" onFinish={(v) => void onRegister(v)}>
            <Form.Item
              name="username"
              rules={[
                {
                  validator: (_, v: string) => {
                    const msg = validateUsername(v ?? '')
                    return msg ? Promise.reject(new Error(msg)) : Promise.resolve()
                  }
                }
              ]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder={`用户名（${AUTH_RULES.usernameMin}–${AUTH_RULES.usernameMax} 位）`}
                autoFocus
                maxLength={AUTH_RULES.usernameMax}
              />
            </Form.Item>
            <Form.Item
              name="nickname"
              rules={[
                {
                  validator: (_, v: string) => {
                    const msg = validateNickname(v ?? '')
                    return msg ? Promise.reject(new Error(msg)) : Promise.resolve()
                  }
                }
              ]}
            >
              <Input placeholder="昵称（可选，默认同用户名）" maxLength={AUTH_RULES.nicknameMax} />
            </Form.Item>
            <Form.Item name="password" rules={[{ validator: passwordRule }]} style={{ marginBottom: 8 }}>
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="密码（至少 8 位，含字母和数字）"
                onChange={(e) => setPassword(e.target.value)}
              />
            </Form.Item>
            {password && (
              <div className="login-strength">
                <Progress
                  percent={(strength / 4) * 100}
                  showInfo={false}
                  size="small"
                  strokeColor={STRENGTH_COLOR[strength]}
                />
                <span style={{ color: STRENGTH_COLOR[strength] }}>{STRENGTH_LABEL[strength]}</span>
              </div>
            )}
            <Form.Item
              name="confirm"
              dependencies={['password']}
              rules={[
                { required: true, message: '请再次输入密码' },
                ({ getFieldValue }) => ({
                  validator: (_, v: string) =>
                    !v || getFieldValue('password') === v
                      ? Promise.resolve()
                      : Promise.reject(new Error('两次输入的密码不一致'))
                })
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="确认密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>
              注册并进入
            </Button>
          </Form>
        )}

        {view === 'reset' && (
          <Form layout="vertical" onFinish={(v) => void onReset(v)}>
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名" autoFocus />
            </Form.Item>
            <Form.Item name="recoveryCode" rules={[{ required: true, message: '请输入恢复码' }]}>
              <Input placeholder="恢复码（XXXX-XXXX-XXXX-XXXX）" maxLength={24} />
            </Form.Item>
            <Form.Item name="newPassword" rules={[{ validator: passwordRule }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="新密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy} disabled={locked}>
              重置密码
            </Button>
            <Button type="link" block onClick={() => switchView('login')} style={{ marginTop: 8 }}>
              返回登录
            </Button>
          </Form>
        )}

        {view !== 'reset' && (
          <div className="login-guest">
            <Button type="text" block disabled={busy} onClick={() => void onGuest()}>
              游客体验（不注册，数据仅保存在游客空间）
            </Button>
          </div>
        )}
      </div>

      <RecoveryCodeDialog
        open={!!recovery}
        code={recovery?.code ?? ''}
        rotated={recovery?.rotated}
        onConfirm={() => {
          const after = recovery?.after ?? 'login'
          const rotated = recovery?.rotated
          setRecovery(null)
          if (rotated) switchView(after) // 重置密码后回登录页
          else onDone() // 注册已自动登录，进入应用
        }}
      />
    </div>
  )
}
