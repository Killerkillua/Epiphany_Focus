import { useEffect, useRef, useState } from 'react'
import { Button, DatePicker, Input, Select, Tooltip } from 'antd'
import { SearchOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { useProgressStore } from '../../store/progressStore'
import { STATUS_META } from './format'

const { RangePicker } = DatePicker

/** 时间范围预设（M1：今天 / 本周(周一起) / 本月）→ updated_at 毫秒区间 */
function rangeFor(mode: 'today' | 'week' | 'month'): { start: number; end: number } {
  const now = new Date()
  const end = now.getTime()
  if (mode === 'today') {
    return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), end }
  }
  if (mode === 'month') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end }
  }
  // 本周：周一开始
  const d = new Date(now)
  const day = d.getDay() // 0=周日
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff)
  monday.setHours(0, 0, 0, 0)
  return { start: monday.getTime(), end }
}

const RANGE_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'custom', label: '自定义' }
]

const SORT_OPTIONS = [
  { value: 'updated_at:desc', label: '最近学习' },
  { value: 'updated_at:asc', label: '最早学习' },
  { value: 'progress:desc', label: '进度从高到低' },
  { value: 'progress:asc', label: '进度从低到高' },
  { value: 'duration:desc', label: '总时长长到短' },
  { value: 'title:asc', label: '标题 A-Z' }
]

/**
 * 筛选排序栏（M1）：搜索（防抖 300ms）/ 状态 / 标签多选 / 时间范围（含自定义）/
 * 六维排序 / 批量管理模式开关。
 */
function ProgressFilterBar(): JSX.Element {
  const filter = useProgressStore((s) => s.filter)
  const allTags = useProgressStore((s) => s.allTags)
  const selectMode = useProgressStore((s) => s.selectMode)
  const setFilter = useProgressStore((s) => s.setFilter)
  const setSelectMode = useProgressStore((s) => s.setSelectMode)

  const [keyword, setKeyword] = useState(filter.keyword ?? '')
  // 时间范围模式：从 store 反推（已有 dateRange 视为自定义），保持重挂载后一致
  const [rangeMode, setRangeMode] = useState(filter.dateRange ? 'custom' : 'all')
  const debounceRef = useRef<number | null>(null)

  // 关键词防抖：300ms 后落 store（避免每次击键都查 SQL）
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      setFilter({ keyword: keyword.trim() })
    }, 300)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword])

  const handleRangeChange = (mode: string): void => {
    setRangeMode(mode)
    if (mode === 'custom') {
      setFilter({ dateRange: null })
    } else if (mode === 'all') {
      setFilter({ dateRange: null })
    } else {
      setFilter({ dateRange: rangeFor(mode as 'today' | 'week' | 'month') })
    }
  }

  const handleSortChange = (value: string): void => {
    const [sortBy, sortOrder] = value.split(':')
    setFilter({
      sortBy: sortBy as 'updated_at' | 'progress' | 'duration' | 'title',
      sortOrder: sortOrder as 'asc' | 'desc'
    })
  }

  return (
    <div className="progress-filter-bar">
      <Input
        size="small"
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索视频标题"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        className="progress-filter-search"
      />
      <Select
        size="small"
        value={filter.status ?? 'all'}
        onChange={(v) => setFilter({ status: v })}
        options={[
          { value: 'all', label: '全部状态' },
          { value: 'planned', label: STATUS_META.planned.label },
          { value: 'learning', label: STATUS_META.learning.label },
          { value: 'done', label: STATUS_META.done.label }
        ]}
        className="progress-filter-status"
      />
      <Select
        size="small"
        mode="multiple"
        allowClear
        placeholder="标签"
        value={filter.tags ?? []}
        onChange={(v: string[]) => setFilter({ tags: v })}
        options={allTags.map((t) => ({ value: t, label: t }))}
        maxTagCount="responsive"
        className="progress-filter-tags"
      />
      <Select
        size="small"
        value={rangeMode}
        onChange={handleRangeChange}
        options={RANGE_OPTIONS}
        className="progress-filter-range"
      />
      {rangeMode === 'custom' && (
        <RangePicker
          size="small"
          allowClear
          onChange={(dates) => {
            if (dates && dates[0] && dates[1]) {
              setFilter({
                dateRange: {
                  start: dates[0].startOf('day').valueOf(),
                  end: dates[1].endOf('day').valueOf()
                }
              })
            } else {
              setFilter({ dateRange: null })
            }
          }}
          className="progress-filter-custom"
        />
      )}
      <Select
        size="small"
        value={`${filter.sortBy}:${filter.sortOrder}`}
        onChange={handleSortChange}
        options={SORT_OPTIONS}
        className="progress-filter-sort"
      />
      <Tooltip title={selectMode ? '退出批量管理' : '进入批量选择模式'}>
        <Button
          size="small"
          type={selectMode ? 'primary' : 'default'}
          icon={<UnorderedListOutlined />}
          onClick={() => setSelectMode(!selectMode)}
        >
          管理
        </Button>
      </Tooltip>
    </div>
  )
}

export default ProgressFilterBar
