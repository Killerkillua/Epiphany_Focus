import { useState } from 'react'
import { Alert, Button, Checkbox, Modal, Typography, message } from 'antd'
import { CopyOutlined } from '@ant-design/icons'

interface RecoveryCodeDialogProps {
  open: boolean
  code: string
  /** 重置密码后展示新恢复码时为 true，仅影响文案 */
  rotated?: boolean
  onConfirm: () => void
}

/** 恢复码展示弹窗：必须勾选"已保存"才能继续，且不可点遮罩/Esc 关闭 */
export default function RecoveryCodeDialog({
  open,
  code,
  rotated,
  onConfirm
}: RecoveryCodeDialogProps): JSX.Element {
  const [saved, setSaved] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      message.success('已复制恢复码')
    } catch {
      message.warning('复制失败，请手动抄写')
    }
  }

  return (
    <Modal
      title={rotated ? '🔑 新的账号恢复码' : '🔑 请保存你的账号恢复码'}
      open={open}
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={
        <Button
          type="primary"
          disabled={!saved}
          onClick={() => {
            setSaved(false)
            onConfirm()
          }}
        >
          我已保存，继续
        </Button>
      }
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="忘记密码时，恢复码是找回账号的唯一方式。它只会显示这一次，系统不保存明文。"
      />
      <div className="recovery-code-box">
        <Typography.Text className="recovery-code-text" copyable={false}>
          {code}
        </Typography.Text>
        <Button icon={<CopyOutlined />} onClick={() => void copy()}>
          复制
        </Button>
      </div>
      {rotated && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          旧恢复码已作废，请以此为准。
        </Typography.Paragraph>
      )}
      <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)}>
        我已将恢复码保存到安全的地方
      </Checkbox>
    </Modal>
  )
}
