import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/**
 * 学习统计存储层测试（db.ts 的 study_stats / sessions 聚合逻辑）。
 * 覆盖：recordStudyStats UPSERT 与统一取整、getDayTrend 窗口、
 *       getModeCompare 排序、getHomeSummary 连续天数、getHourHeatmap 分组与小数分钟。
 * 每个用例使用独立的临时 SQLite 文件（POMODORO_DB_PATH 注入），互不干扰。
 */

// electron 在纯 Node 测试环境下不可用，替换为最小桩（与 settings.test.ts 一致）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/electron-userData' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  addFeedback,
  closeDb,
  deleteNote,
  getDayTrend,
  getFeedbackStats,
  getHomeSummary,
  getHourHeatmap,
  getModeCompare,
  getPlayRecord,
  listFeedback,
  listPlayRecords,
  loadNotesAll,
  loadNotesByVideo,
  markPlayRecordDone,
  recordSessionEnd,
  recordSessionStart,
  recordStudyStats,
  saveNotesAll,
  setPlayGoal,
  tickPlayRecord,
  todayLocal,
  upsertNote,
  upsertPlayRecord
} from './db'

function localDateStr(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 距今 n 天的本地日期（YYYY-MM-DD） */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDateStr(d)
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pomodoro-db-'))
  process.env.POMODORO_DB_PATH = join(dir, 'test.db')
  // better-sqlite3 按 Electron ABI 编译，vitest（系统 Node）无法加载原生绑定；
  // 测试改用系统 Node 内置 SQLite 驱动（db.ts 的 POMODORO_DB_DRIVER 钩子）
  process.env.POMODORO_DB_DRIVER = 'node:sqlite'
  closeDb() // 释放上一个用例的连接，确保新路径生效
})

afterEach(() => {
  closeDb()
  delete process.env.POMODORO_DB_PATH
  delete process.env.POMODORO_DB_DRIVER
  rmSync(dir, { recursive: true, force: true })
})

describe('recordStudyStats（study_stats UPSERT）', () => {
  it('同日同模式累加，不同模式独立成行', () => {
    recordStudyStats('2024-06-01', 'focus', 25 * 60_000, 1)
    recordStudyStats('2024-06-01', 'focus', 25 * 60_000, 1)
    recordStudyStats('2024-06-01', 'english', 40 * 60_000, 1)

    const modes = getModeCompare()
    expect(modes.find((m) => m.mode === 'focus')).toEqual({ mode: 'focus', minutes: 50, pomos: 2 })
    expect(modes.find((m) => m.mode === 'english')).toEqual({ mode: 'english', minutes: 40, pomos: 1 })
  })

  it('模式对比按累计分钟降序', () => {
    recordStudyStats('2024-06-01', 'focus', 10 * 60_000, 1)
    recordStudyStats('2024-06-02', 'english', 60 * 60_000, 1)
    expect(getModeCompare().map((m) => m.mode)).toEqual(['english', 'focus'])
  })

  it('统一四舍五入：90s→2min、41.7min→42min；不足 1 分钟不记录', () => {
    const day = daysAgo(1)
    recordStudyStats(day, 'focus', 90_000, 1) // 1.5 → 2
    recordStudyStats(day, 'focus', 2_500_000, 1) // 41.67 → 42
    recordStudyStats(day, 'focus', 30_000, 1) // < 60s → 跳过

    const row = getDayTrend(7).find((p) => p.date === day)
    expect(row?.minutes).toBe(44)
    expect(row?.pomos).toBe(2)
  })
})

describe('getDayTrend（按日期聚合 + 窗口）', () => {
  it('返回窗口内每日聚合，窗口外不返回', () => {
    recordStudyStats(daysAgo(0), 'focus', 25 * 60_000, 1)
    recordStudyStats(daysAgo(1), 'bili', 40 * 60_000, 2)
    recordStudyStats('2024-01-01', 'focus', 60 * 60_000, 1) // 超出窗口

    const rows = getDayTrend(7)
    expect(rows).toHaveLength(2)
    expect(rows.find((p) => p.date === daysAgo(0))?.minutes).toBe(25)
    expect(rows.find((p) => p.date === daysAgo(1))?.pomos).toBe(2)
    expect(rows.some((p) => p.date === '2024-01-01')).toBe(false)
  })
})

describe('getHomeSummary（今日聚合 + 连续天数）', () => {
  it('今日多模式聚合分钟与番茄', () => {
    recordStudyStats(todayLocal(), 'focus', 25 * 60_000, 1)
    recordStudyStats(todayLocal(), 'english', 30 * 60_000, 1)
    const s = getHomeSummary()
    expect(s.todayMinutes).toBe(55)
    expect(s.todayPomos).toBe(2)
  })

  it('连续 3 天（含今天）→ streak 3', () => {
    recordStudyStats(daysAgo(0), 'focus', 25 * 60_000, 1)
    recordStudyStats(daysAgo(1), 'focus', 25 * 60_000, 1)
    recordStudyStats(daysAgo(2), 'focus', 25 * 60_000, 1)
    expect(getHomeSummary().streakDays).toBe(3)
  })

  it('今天未学但昨天/前天有 → 从昨天起算', () => {
    recordStudyStats(daysAgo(1), 'focus', 25 * 60_000, 1)
    recordStudyStats(daysAgo(2), 'focus', 25 * 60_000, 1)
    expect(getHomeSummary().streakDays).toBe(2)
  })

  it('中断（前天缺失）→ streak 只统计最近连续段', () => {
    recordStudyStats(daysAgo(0), 'focus', 25 * 60_000, 1)
    recordStudyStats(daysAgo(1), 'focus', 25 * 60_000, 1)
    recordStudyStats(daysAgo(3), 'focus', 25 * 60_000, 1) // daysAgo(2) 缺失
    expect(getHomeSummary().streakDays).toBe(2)
  })
})

describe('getHourHeatmap（sessions 聚合）', () => {
  it('按星期×小时聚合，分钟保留小数（修复整数除法截断）；abandoned 不计入', () => {
    // 2024-01-07 是周日（strftime %w = 0），本地时间 09:00
    const t0 = new Date(2024, 0, 7, 9, 0, 0).getTime()
    const id1 = recordSessionStart({ mode: 'focus', level: 'L0', startedAt: t0, durationPlanned: 60_000 })
    expect(id1).toBeTruthy()
    recordSessionEnd(id1!, { durationActual: 90_000, pomosCompleted: 1, interruptions: 0, status: 'done' })

    const t1 = new Date(2024, 0, 7, 9, 30, 0).getTime()
    const id2 = recordSessionStart({ mode: 'bili', level: 'L0', startedAt: t1, durationPlanned: 60_000 })
    recordSessionEnd(id2!, { durationActual: 60_000, pomosCompleted: 1, interruptions: 0, status: 'done' })

    // abandoned 会话不应计入热力图
    const id3 = recordSessionStart({ mode: 'english', level: 'L0', startedAt: t1, durationPlanned: 60_000 })
    recordSessionEnd(id3!, { durationActual: 60_000, pomosCompleted: 0, interruptions: 0, status: 'abandoned' })

    const cells = getHourHeatmap()
    const cell = cells.find((c) => c.weekday === 0 && c.hour === 9)
    expect(cell).toBeDefined()
    // (90s + 60s) / 60 = 2.5 分钟：验证非整数除法截断（修复前为 2）
    expect(cell!.minutes).toBeCloseTo(2.5, 5)
    expect(cell!.sessions).toBe(2)
  })
})

/* ================= notes（增量 upsert + 分视频归档，F-1/P-1） ================= */

describe('notes（增量 upsert / 按 id 删除 / 分视频归档）', () => {
  it('同 id 重复 upsert 不产生重复行，内容被更新', () => {
    const first = upsertNote({ id: 'n-1', createdAt: 1000, content: '第一条' })
    const second = upsertNote({ id: 'n-1', createdAt: 1000, content: '第一条（修订）' })
    expect(first.id).toBe('n-1')
    expect(second.id).toBe('n-1')

    const all = loadNotesAll()
    expect(all).toHaveLength(1)
    expect(all[0].content).toBe('第一条（修订）')
  })

  it('不同 id 各自成行，按创建时间倒序返回', () => {
    upsertNote({ id: 'a', createdAt: 1000, content: '旧' })
    upsertNote({ id: 'b', createdAt: 2000, content: '新' })
    const all = loadNotesAll()
    expect(all.map((n) => n.id)).toEqual(['b', 'a'])
  })

  it('deleteNote 只删指定 id', () => {
    upsertNote({ id: 'a', createdAt: 1000, content: 'A' })
    upsertNote({ id: 'b', createdAt: 1000, content: 'B' })
    deleteNote('a')
    const all = loadNotesAll()
    expect(all.map((n) => n.id)).toEqual(['b'])
  })

  it('loadNotesByVideo 按 bvid 归档过滤；未带 bvid 的笔记不混入', () => {
    upsertNote({ id: 'v1', createdAt: 1000, content: '视频1笔记', bvid: 'BV1', videoTitle: '视频一' })
    upsertNote({ id: 'v2', createdAt: 1000, content: '视频2笔记', bvid: 'BV2' })
    upsertNote({ id: 'g1', createdAt: 1000, content: '通用笔记' })

    const v1 = loadNotesByVideo('BV1')
    expect(v1).toHaveLength(1)
    expect(v1[0].id).toBe('v1')
    expect(v1[0].bvid).toBe('BV1')
    expect(v1[0].videoTitle).toBe('视频一')
    expect(loadNotesByVideo('BV2')[0].id).toBe('v2')
  })

  it('重点标记字段 is_key / 时间戳 timestamp_s / 来源 source 完整往返', () => {
    upsertNote({
      id: 'k1',
      createdAt: 1000,
      content: '重点',
      bvid: 'BV1',
      timestampS: 123,
      isKey: true,
      source: 'time-mark'
    })
    const entry = loadNotesByVideo('BV1')[0]
    expect(entry.isKey).toBe(true)
    expect(entry.timestampS).toBe(123)
    expect(entry.source).toBe('time-mark')
  })

  it('saveNotesAll 以入参集合为应有集合：删除集合外、保留集合内（兼容旧契约）', () => {
    upsertNote({ id: 'keep', createdAt: 1000, content: '保留' })
    upsertNote({ id: 'drop', createdAt: 1000, content: '删除' })
    saveNotesAll([{ id: 'keep', createdAt: 1000, content: '保留（改）' }, { id: 'new', createdAt: 2000, content: '新增' }])

    const all = loadNotesAll()
    expect(all.map((n) => n.id).sort()).toEqual(['keep', 'new'])
    expect(all.find((n) => n.id === 'keep')?.content).toBe('保留（改）')
  })
})

describe('notes 表迁移（旧 INTEGER 主键 → TEXT 主键 + 新字段，数据零丢失）', () => {
  it('旧结构表迁移后旧行保留、新字段可用', () => {
    // 先用原生驱动建"旧结构" notes 表并写入旧数据（绕过 getDb 的新 SCHEMA）
    closeDb()
    const { DatabaseSync } = createRequire(__filename)('node:sqlite') as typeof import('node:sqlite')
    const raw = new DatabaseSync(process.env.POMODORO_DB_PATH!)
    raw.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        video_title TEXT DEFAULT '',
        content TEXT NOT NULL,
        tags TEXT DEFAULT ''
      );
      INSERT INTO notes (created_at, video_title, content, tags) VALUES (1000, '旧视频', '旧笔记内容', '');
    `)
    raw.close()

    // 重新打开（触发 getDb → SCHEMA(IF NOT EXISTS) + migrateNotesTable）
    const all = loadNotesAll()
    expect(all).toHaveLength(1)
    expect(all[0].content).toBe('旧笔记内容')
    expect(all[0].id).toBe('1') // 旧 INTEGER id 经 CAST 保留为文本

    // 迁移后可写新字段
    const saved = upsertNote({ id: all[0].id, createdAt: all[0].createdAt, content: '旧笔记内容', bvid: 'BV9', isKey: true })
    expect(saved.bvid).toBe('BV9')
    const reloaded = loadNotesByVideo('BV9')
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].isKey).toBe(true)
  })
})

/* ================= play_records（按视频学习进度，F-3） ================= */

describe('play_records（进度累计 / 状态 / 目标）', () => {
  it('tickPlayRecord 累计观看时长并刷新位置，状态置为 learning', () => {
    upsertPlayRecord({ bvid: 'BV1', title: '视频一', durationS: 600, positionS: 0 })
    tickPlayRecord({ bvid: 'BV1', watchedDeltaS: 30, positionS: 30 })
    tickPlayRecord({ bvid: 'BV1', watchedDeltaS: 30, positionS: 60 })

    const rec = getPlayRecord('BV1')
    expect(rec?.watchedS).toBe(60)
    expect(rec?.lastPositionS).toBe(60)
    expect(rec?.status).toBe('learning')
    expect(rec?.durationS).toBe(600)
  })

  it('upsertPlayRecord 打开视频时累加 viewed_count，不重置已累计时长', () => {
    upsertPlayRecord({ bvid: 'BV2', title: '视频二', viewedCount: 1 })
    tickPlayRecord({ bvid: 'BV2', watchedDeltaS: 90, positionS: 90 })
    upsertPlayRecord({ bvid: 'BV2', title: '视频二', viewedCount: 2 })

    const rec = getPlayRecord('BV2')
    expect(rec?.viewedCount).toBe(2)
    expect(rec?.watchedS).toBe(90)
  })

  it('markPlayRecordDone 置为 done；setPlayGoal 保存目标遍数与截止日期', () => {
    upsertPlayRecord({ bvid: 'BV3', title: '视频三' })
    markPlayRecordDone('BV3')
    expect(getPlayRecord('BV3')?.status).toBe('done')

    setPlayGoal('BV3', { goalRounds: 3, goalDeadline: '2026-12-31' })
    const rec = getPlayRecord('BV3')
    expect(rec?.goalRounds).toBe(3)
    expect(rec?.goalDeadline).toBe('2026-12-31')

    // done 状态不被学习心跳降级
    tickPlayRecord({ bvid: 'BV3', watchedDeltaS: 10, positionS: 10 })
    expect(getPlayRecord('BV3')?.status).toBe('done')
  })

  it('listPlayRecords 按更新时间倒序返回全部', () => {
    upsertPlayRecord({ bvid: 'BV1', title: '一' })
    tickPlayRecord({ bvid: 'BV2', watchedDeltaS: 5, positionS: 5 })
    const list = listPlayRecords()
    expect(list.map((r) => r.bvid)).toEqual(['BV2', 'BV1'])
  })
})

/* ================= feedback（用户反馈，R-1） ================= */

describe('feedback（提交 / 列表 / 聚合）', () => {
  it('提交反馈落库并返回条目；评分钳制到 1-5', () => {
    const entry = addFeedback({ mode: 'bili', rating: 9, category: '卡顿', detail: '全屏时卡' })
    expect(entry?.rating).toBe(5)
    expect(listFeedback()).toHaveLength(1)
  })

  it('getFeedbackStats 计算平均分与分类计数', () => {
    addFeedback({ mode: 'bili', rating: 5, category: '卡顿', detail: '' })
    addFeedback({ mode: 'bili', rating: 3, category: '其他', detail: '' })
    addFeedback({ mode: 'bili', rating: 4, category: '卡顿', detail: '' })

    const stats = getFeedbackStats()
    expect(stats.count).toBe(3)
    expect(stats.avgRating).toBe(4)
    expect(stats.byCategory['卡顿']).toBe(2)
    expect(stats.byCategory['其他']).toBe(1)
  })
})
