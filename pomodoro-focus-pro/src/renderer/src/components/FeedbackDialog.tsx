import { useState } from 'react'
import { Input, Modal, Radio, Rate, message } from 'antd'
import type { FeedbackCategory } from '../../../shared/stats'

const CATEGORY_OPTIONS: FeedbackCategory[] = [
  '卡顿',
  '遮不住视频',
  '退出不便',
  '笔记丢失',
  'AI 回答质量',
  '其他'
]

const RATE_TOOLTIPS = ['很差', '较差', '一般', '较好', '很棒']

interface FeedbackDialogProps {
  open: boolean
  /** 反馈来源模式（bili / english / focus / general） */
  mode?: string
  onClose(): void
}

/**
 * 轻量应用内反馈（R-1）：满意度打分（★/5）+ 分类 + 一句话描述，
 * 点击提交写入本地 feedback 表（默认不上传），3 步内完成。
 */
function FeedbackDialog({ open, mode = 'general', onClose }: FeedbackDialogProps): JSX.Element {
  const [rating, setRating] = useState(5)
  const [category, setCategory] = useState<FeedbackCategory>('其他')
  const [detail, setDetail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    try {
      const result = await window.api.feedback.submit({
        mode,
        rating,
        category,
        detail: detail.trim()
      })
      if (!result) throw new Error('提交失败')
      message.success('感谢反馈！已保存到本地')
      setDetail('')
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="反馈学习助手"
      open={open}
      onOk={() => void submit()}
      onCancel={onClose}
      okText="提交反馈"
      cancelText="取消"
      confirmLoading={submitting}
      width={420}
    >
      <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        反馈仅保存在本地，不会上传。你的意见将帮助我们改进学习体验。
      </p>
      {/* 无障碍：用 fieldset/legend 做原生标签关联（等价于 aria-labelledby，
          且不依赖 antd Rate/Radio.Group 是否透传 aria 属性） */}
      <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
        <legend style={{ fontSize: 13, marginBottom: 6 }}>满意度</legend>
        <Rate value={rating} onChange={setRating} tooltips={RATE_TOOLTIPS} />
      </fieldset>
      <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
        <legend style={{ fontSize: 13, marginBottom: 6 }}>遇到什么</legend>
        <Radio.Group
          size="small"
          optionType="button"
          buttonStyle="solid"
          options={CATEGORY_OPTIONS.map((c) => ({ label: c, value: c }))}
          value={category}
          onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
        />
      </fieldset>
      <Input.TextArea
        maxLength={300}
        showCount
        placeholder="一句话描述…"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        autoSize={{ minRows: 2, maxRows: 4 }}
      />
    </Modal>
  )
}

export default FeedbackDialog
