import { useEffect, useState } from 'react'
import { Input, Modal, Space, Typography, message } from 'antd'

interface RecoveryCodeModalProps {
  open: boolean
  hasCode: boolean
  onClose: () => void
  /** 保存成功后刷新设置快照 */
  onSaved: () => Promise<void>
}

/** 紧急恢复码设置弹窗（CR-02：已设置过时必须携带旧码验证） */
export default function RecoveryCodeModal({
  open,
  hasCode,
  onClose,
  onSaved
}: RecoveryCodeModalProps): JSX.Element {
  const [codeOld, setCodeOld] = useState('')
  const [code1, setCode1] = useState('')
  const [code2, setCode2] = useState('')

  // 每次打开时清空旧码输入（与原实现打开前 setCodeOld('') 一致）
  useEffect(() => {
    if (open) setCodeOld('')
  }, [open])

  const handleSetCode = async (): Promise<void> => {
    if (code1.length < 6) {
      message.warning('恢复码至少 6 位')
      return
    }
    if (code1 !== code2) {
      message.warning('两次输入不一致')
      return
    }
    try {
      // CR-02：已设置过恢复码时必须携带旧码验证（主进程比对，防止被直接覆盖）
      await window.api.emergency.setCode(code1, hasCode ? codeOld : undefined)
      message.success('紧急恢复码已保存（bcrypt 哈希存储）')
      setCodeOld('')
      setCode1('')
      setCode2('')
      onClose()
      await onSaved()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '设置失败')
    }
  }

  return (
    <Modal
      title="设置紧急恢复码"
      open={open}
      onOk={() => void handleSetCode()}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          恢复码用于强制会话紧急退出（连按 5 次 Esc 触发）。至少 6 位，仅存 bcrypt 哈希。
        </Typography.Text>
        {hasCode && (
          <Input.Password
            placeholder="旧恢复码（验证身份）"
            value={codeOld}
            onChange={(e) => setCodeOld(e.target.value)}
          />
        )}
        <Input.Password
          placeholder="新恢复码（至少 6 位）"
          value={code1}
          onChange={(e) => setCode1(e.target.value)}
        />
        <Input.Password
          placeholder="再次输入"
          value={code2}
          onChange={(e) => setCode2(e.target.value)}
        />
      </Space>
    </Modal>
  )
}
