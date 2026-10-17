import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  addVocab,
  batchDeletePlayRecords,
  batchUpdatePlayRecords,
  closeDb,
  deleteNote,
  deletePlayRecord,
  deleteVocab,
  exportBackupData,
  getAllPlayRecordTags,
  getDailyStudyMinutes,
  getDayTrend,
  getDb,
  getFeedbackStats,
  getHomeSummary,
  getHourHeatmap,
  getModeCompare,
  getPlayRecord,
  getPlaySourceUri,
  getProgressStats,
  getStudySessionsByVideo,
  importBackupData,
  listBackupMeta,
  listFeedback,
  listPlayRecords,
  listVocab,
  loadNotesAll,
  loadNotesByVideo,
  markPlayRecordDone,
  migrateNotesTable,
  recordSessionEnd,
  recordSessionStart,
  recordStudySessionEnd,
  recordStudySessionStart,
  recordStudyStats,
  searchPlayRecords,
  setPlayGoal,
  setPlayRecordTags,
  tickPlayRecord,
  todayLocal,
  updatePlayRecord,
  updateVocabDefinition,
  upsertNote,
  upsertPlayRecord
} from './db'
import { backfillHeatmapIfEmpty } from './heatmap'
import { creditFocusPomodoro } from './taskRepository'
import { setSettings } from './settings'
import { buildBackupFile, parseBackupFile, pruneBackups, writeBackupFile } from './backup'
import type { PlayStatus } from '../../shared/stats'
import type { PlayRecord } from '../../shared/stats'

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
    expect(modes.find((m) => m.mode === 'english')).toEqual({
      mode: 'english',
      minutes: 40,
      pomos: 1
    })
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
    const id1 = recordSessionStart({
      mode: 'focus',
      level: 'L0',
      startedAt: t0,
      durationPlanned: 60_000
    })
    expect(id1).toBeTruthy()
    recordSessionEnd(id1!, {
      durationActual: 90_000,
      pomosCompleted: 1,
      interruptions: 0,
      status: 'done'
    })

    const t1 = new Date(2024, 0, 7, 9, 30, 0).getTime()
    const id2 = recordSessionStart({
      mode: 'bili',
      level: 'L0',
      startedAt: t1,
      durationPlanned: 60_000
    })
    recordSessionEnd(id2!, {
      durationActual: 60_000,
      pomosCompleted: 1,
      interruptions: 0,
      status: 'done'
    })

    // abandoned 会话不应计入热力图
    const id3 = recordSessionStart({
      mode: 'english',
      level: 'L0',
      startedAt: t1,
      durationPlanned: 60_000
    })
    recordSessionEnd(id3!, {
      durationActual: 60_000,
      pomosCompleted: 0,
      interruptions: 0,
      status: 'abandoned'
    })

    const cells = getHourHeatmap()
    const cell = cells.find((c) => c.weekday === 0 && c.hour === 9)
    expect(cell).toBeDefined()
    // (90s + 60s) / 60 = 2.5 分钟：验证非整数除法截断（修复前为 2）
    expect(cell!.minutes).toBeCloseTo(2.5, 5)
    expect(cell!.sessions).toBe(2)
  })

  it('空表从已完成会话回填；倒计时入账后再结束不重复计数', () => {
    const t0 = new Date(2024, 0, 8, 11, 0, 0).getTime()
    const id = recordSessionStart({
      mode: 'focus',
      level: 'L0',
      startedAt: t0,
      durationPlanned: 60_000
    })
    const d = getDb()
    expect(d).toBeTruthy()
    d!.prepare(
      `UPDATE sessions SET status = 'done', ended_at = ?, duration_actual = 120000 WHERE id = ?`
    ).run(t0 + 120_000, id)
    d!.exec('DELETE FROM heatmap_cells')
    backfillHeatmapIfEmpty(d!)
    const filled = getHourHeatmap().find((c) => c.weekday === 1 && c.hour === 11)
    expect(filled?.sessions).toBe(1)
    expect(filled?.minutes).toBeCloseTo(2, 5)

    const t1 = new Date(2024, 0, 8, 12, 0, 0).getTime()
    const id2 = recordSessionStart({
      mode: 'focus',
      level: 'L0',
      startedAt: t1,
      durationPlanned: 60_000
    })
    expect(creditFocusPomodoro(id2!, 90_000)).toBe(true)
    recordSessionEnd(id2!, {
      durationActual: 90_000,
      pomosCompleted: 1,
      interruptions: 0,
      status: 'done'
    })
    const credited = getHourHeatmap().find((c) => c.weekday === 1 && c.hour === 12)
    expect(credited?.sessions).toBe(1)
    expect(credited?.minutes).toBeCloseTo(1.5, 5)
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
    upsertNote({
      id: 'v1',
      createdAt: 1000,
      content: '视频1笔记',
      bvid: 'BV1',
      videoTitle: '视频一'
    })
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

  it('只 upsert B 时已存在的 A 仍在（不会整表覆盖）', () => {
    upsertNote({ id: 'a', createdAt: 1000, content: 'A' })
    upsertNote({ id: 'b', createdAt: 2000, content: 'B' })
    const all = loadNotesAll()
    expect(all.map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(all.find((n) => n.id === 'a')?.content).toBe('A')
  })
})

describe('notes 表迁移（旧 INTEGER 主键 → TEXT 主键 + 新字段，数据零丢失）', () => {
  it('旧结构表迁移后旧行保留、新字段可用', () => {
    // 先用原生驱动建"旧结构" notes 表并写入旧数据（绕过 getDb 的新 SCHEMA）
    closeDb()
    const { DatabaseSync } = createRequire(__filename)(
      'node:sqlite'
    ) as typeof import('node:sqlite')
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
    const saved = upsertNote({
      id: all[0].id,
      createdAt: all[0].createdAt,
      content: '旧笔记内容',
      bvid: 'BV9',
      isKey: true
    })
    expect(saved.bvid).toBe('BV9')
    const reloaded = loadNotesByVideo('BV9')
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].isKey).toBe(true)
  })

  it('迁移失败整体回滚：旧表结构与数据完整保留（原子性，P0）', () => {
    // 建"旧结构" notes 表并写入旧数据（绕过 getDb 的新 SCHEMA）
    closeDb()
    const { DatabaseSync } = createRequire(__filename)(
      'node:sqlite'
    ) as typeof import('node:sqlite')
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

    // 包装驱动：迁移主体 exec（RENAME→CREATE→INSERT→DROP）抛错，模拟中途失败
    let execCount = 0
    const broken = {
      exec: (sql: string): void => {
        execCount += 1
        if (execCount === 1) throw new Error('模拟迁移中途失败')
        raw.exec(sql)
      },
      prepare: (sql: string): ReturnType<typeof raw.prepare> => raw.prepare(sql)
    }
    // 迁移内部吞错（打日志），对外不抛；关键是状态必须回滚
    expect(() =>
      migrateNotesTable(broken as unknown as Parameters<typeof migrateNotesTable>[0])
    ).not.toThrow()

    // 回滚后：notes 仍是旧结构、旧数据完好；无孤立 notes_legacy（无半迁移状态）
    const names = (raw.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(names).not.toContain('bvid')
    expect(names).not.toContain('timestamp_s')
    const count = raw.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }
    expect(count.c).toBe(1)
    const legacy = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes_legacy'`)
      .get()
    expect(legacy).toBeUndefined()
    raw.close()
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

  it('listPlayRecords 按更新时间倒序返回全部', async () => {
    upsertPlayRecord({ bvid: 'BV1', title: '一' })
    // 两次写入若落在同一毫秒，updated_at 相同、排序退化为插入序导致 flaky：
    // 等待 ≥2ms 确保 BV2 的 updated_at 严格更大
    await new Promise((r) => setTimeout(r, 5))
    tickPlayRecord({ bvid: 'BV2', watchedDeltaS: 5, positionS: 5 })
    const list = listPlayRecords()
    expect(list.map((r) => r.bvid)).toEqual(['BV2', 'BV1'])
  })

  it('listPlayRecords 默认最多 2000 条，unlimited 仍返回全量', () => {
    for (let i = 0; i < 2001; i++) upsertPlayRecord({ bvid: `BVc${i}`, title: String(i) })
    expect(listPlayRecords()).toHaveLength(2000)
    expect(listPlayRecords({ unlimited: true })).toHaveLength(2001)
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

/* ================= M1 学习记录管理（删除 / 批量删除 / 修改 / 标签 / 筛选排序） ================= */

describe('play_records M1 管理（删除 / 批量删除 / 修改 / 标签 / 筛选排序）', () => {
  it('deletePlayRecord 删除记录+标签+会话；笔记保留（决策）；deleteNotes 时连笔记删除', () => {
    upsertPlayRecord({
      bvid: 'BV10',
      title: '待删',
      coverUrl: 'bili-image://img/?url=x',
      author: 'UP1'
    })
    setPlayRecordTags('BV10', ['前端'])
    const sid = recordStudySessionStart('BV10', 'manual')
    recordStudySessionEnd(sid ?? 0)
    upsertNote({ id: 'n-1', createdAt: Date.now(), content: '笔记', bvid: 'BV10' })

    expect(deletePlayRecord('BV10')).toBe(true)
    expect(getPlayRecord('BV10')).toBeNull()
    expect(getAllPlayRecordTags()).toEqual([])
    expect(getStudySessionsByVideo('BV10')).toEqual([])
    // 笔记保留（决策：删除学习记录不级联删笔记）
    expect(loadNotesAll().find((n) => n.id === 'n-1')).toBeTruthy()

    // deleteNotes 选项：连笔记一起删
    upsertPlayRecord({ bvid: 'BV11', title: '连删' })
    upsertNote({ id: 'n-2', createdAt: Date.now(), content: 'x', bvid: 'BV11' })
    deletePlayRecord('BV11', { deleteNotes: true })
    expect(loadNotesAll().find((n) => n.id === 'n-2')).toBeUndefined()
  })

  it('batchDeletePlayRecords 事务批量删除', () => {
    for (const b of ['BV20', 'BV21', 'BV22']) upsertPlayRecord({ bvid: b, title: b })
    expect(batchDeletePlayRecords(['BV20', 'BV21'])).toBe(2)
    expect(getPlayRecord('BV20')).toBeNull()
    expect(getPlayRecord('BV21')).toBeNull()
    expect(getPlayRecord('BV22')).not.toBeNull()
  })

  it('updatePlayRecord 修改状态/时长/位置/次数/目标并刷新 updated_at；非法状态忽略；不存在则创建', async () => {
    upsertPlayRecord({ bvid: 'BV30', title: '改', durationS: 600, positionS: 0 })
    await new Promise((r) => setTimeout(r, 5))
    const rec = updatePlayRecord('BV30', {
      status: 'done',
      watchedS: 3600,
      lastPositionS: 500,
      viewedCount: 3,
      goalRounds: 3,
      goalDeadline: '2026-12-31'
    })
    expect(rec?.status).toBe('done')
    expect(rec?.watchedS).toBe(3600)
    expect(rec?.lastPositionS).toBe(500)
    expect(rec?.viewedCount).toBe(3)
    expect(rec?.goalRounds).toBe(3)
    expect(rec?.goalDeadline).toBe('2026-12-31')
    expect(rec?.updatedAt).toBeGreaterThanOrEqual(Date.now() - 100)
    // 非法状态被忽略（保持原值）
    updatePlayRecord('BV30', { status: 'xxx' as PlayStatus })
    expect(getPlayRecord('BV30')?.status).toBe('done')
    // 记录不存在：以更新内容创建
    const created = updatePlayRecord('BV31', { title: '新', watchedS: 100 })
    expect(created?.bvid).toBe('BV31')
    expect(created?.watchedS).toBe(100)
  })

  it('batchUpdatePlayRecords 批量改状态', () => {
    for (const b of ['BV40', 'BV41']) upsertPlayRecord({ bvid: b })
    expect(batchUpdatePlayRecords(['BV40', 'BV41'], { status: 'learning' })).toBe(2)
    expect(getPlayRecord('BV40')?.status).toBe('learning')
    expect(getPlayRecord('BV41')?.status).toBe('learning')
  })

  it('setPlayRecordTags 整体替换 + 大小写不敏感去重；getAllPlayRecordTags 按使用量排序', () => {
    upsertPlayRecord({ bvid: 'BV50' })
    upsertPlayRecord({ bvid: 'BV51' })
    setPlayRecordTags('BV50', ['React', 'react', ' 前端 ', ''])
    setPlayRecordTags('BV51', ['React'])
    const rec = getPlayRecord('BV50')
    expect(rec?.tags).toEqual(['React', '前端'])
    expect(getAllPlayRecordTags()).toEqual(['React', '前端']) // React 出现 2 次在前
    // 整体替换：清空
    setPlayRecordTags('BV50', [])
    expect(getPlayRecord('BV50')?.tags).toEqual([])
  })

  it('searchPlayRecords 关键字/状态/标签/时间范围/四维排序 组合生效', async () => {
    // BV60：学习中，进度 50%（位置 300/600）
    upsertPlayRecord({ bvid: 'BV60', title: 'React 入门', durationS: 600, positionS: 300 })
    setPlayRecordTags('BV60', ['前端'])
    tickPlayRecord({ bvid: 'BV60', watchedDeltaS: 5, positionS: 300 })
    await new Promise((r) => setTimeout(r, 5))
    // BV61：已完成，进度 90%（位置 1080/1200）
    upsertPlayRecord({ bvid: 'BV61', title: 'Vue 实战', durationS: 1200, positionS: 0 })
    tickPlayRecord({ bvid: 'BV61', watchedDeltaS: 5, positionS: 1080 })
    markPlayRecordDone('BV61')
    await new Promise((r) => setTimeout(r, 5))
    // BV62：计划中，时长未知
    upsertPlayRecord({ bvid: 'BV62', title: 'TypeScript 手册' })

    // 默认最近学习（updated_at DESC）
    expect(
      searchPlayRecords({ sortBy: 'updated_at', sortOrder: 'desc' }).map((r) => r.bvid)
    ).toEqual(['BV62', 'BV61', 'BV60'])
    // 关键字模糊
    expect(
      searchPlayRecords({ keyword: 'react', sortBy: 'updated_at', sortOrder: 'desc' }).map(
        (r) => r.bvid
      )
    ).toEqual(['BV60'])
    // 状态
    expect(
      searchPlayRecords({ status: 'done', sortBy: 'updated_at', sortOrder: 'desc' }).map(
        (r) => r.bvid
      )
    ).toEqual(['BV61'])
    // 标签
    expect(
      searchPlayRecords({ tags: ['前端'], sortBy: 'updated_at', sortOrder: 'desc' }).map(
        (r) => r.bvid
      )
    ).toEqual(['BV60'])
    // 进度降序：BV61(90) > BV60(50) > BV62(0 未知)
    expect(searchPlayRecords({ sortBy: 'progress', sortOrder: 'desc' }).map((r) => r.bvid)).toEqual(
      ['BV61', 'BV60', 'BV62']
    )
    // 进度升序
    expect(searchPlayRecords({ sortBy: 'progress', sortOrder: 'asc' }).map((r) => r.bvid)).toEqual([
      'BV62',
      'BV60',
      'BV61'
    ])
    // 总时长降序：BV61(1200) > BV60(600) > BV62(0)
    expect(searchPlayRecords({ sortBy: 'duration', sortOrder: 'desc' }).map((r) => r.bvid)).toEqual(
      ['BV61', 'BV60', 'BV62']
    )
    // 标题 A-Z（COLLATE NOCASE）
    expect(searchPlayRecords({ sortBy: 'title', sortOrder: 'asc' }).map((r) => r.bvid)).toEqual([
      'BV60',
      'BV62',
      'BV61'
    ])
    // 时间范围：空区间无结果；全区间全量
    expect(
      searchPlayRecords({
        sortBy: 'updated_at',
        sortOrder: 'desc',
        dateRange: { start: 0, end: 1 }
      })
    ).toEqual([])
    expect(
      searchPlayRecords({
        sortBy: 'updated_at',
        sortOrder: 'desc',
        dateRange: { start: 0, end: Date.now() }
      })
    ).toHaveLength(3)
  })
})

/* ================= M3 学习会话明细与统计 ================= */

describe('study_sessions（M3 会话明细）', () => {
  it('start/end 结算墙钟时长；重复 end 幂等；limit 生效', () => {
    const sid = recordStudySessionStart('BV70', 'resume')
    expect(sid).toBeTruthy()
    const before = getStudySessionsByVideo('BV70')[0]
    // 显式 endAt 保证确定性（避免依赖 sleep 计时）
    recordStudySessionEnd(sid ?? 0, before.startAt + 5000)
    recordStudySessionEnd(sid ?? 0, before.startAt + 9999) // 幂等：不重复结算
    const sessions = getStudySessionsByVideo('BV70')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].source).toBe('resume')
    expect(sessions[0].durationS).toBe(5)
    expect(sessions[0].endAt).toBe(before.startAt + 5000)

    const sid2 = recordStudySessionStart('BV70', 'search')
    recordStudySessionEnd(sid2 ?? 0)
    expect(getStudySessionsByVideo('BV70')).toHaveLength(2)
    expect(getStudySessionsByVideo('BV70', 1)).toHaveLength(1)
  })
})

describe('getProgressStats（M3 概览统计）', () => {
  /** 插入指定时刻的学习会话（duration_s 秒） */
  const insertSession = (bvid: string, startAt: number, durationS: number): void => {
    getDb()!
      .prepare(
        `INSERT INTO study_sessions (bvid, start_at, end_at, duration_s, source, created_at)
         VALUES (?, ?, ?, ?, 'manual', ?)`
      )
      .run(bvid, startAt, startAt + durationS * 1000, durationS, Date.now())
  }
  /** 距今 n 天的本地零点时间戳 */
  const dayStart = (n: number): number => {
    const d = new Date()
    d.setDate(d.getDate() - n)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  it('聚合今日/本周/本月时长、streak、周学习天数、课程计数与全局目标', () => {
    setSettings({ 'studyGoals.dailyMinutes': 90, 'studyGoals.weeklyDays': 4 })
    // 今天：10 分钟 + 5 分钟；昨天：5 分钟；3 天前：10 分钟；10 天前：20 分钟（可能跨月）
    insertSession('BV80', dayStart(0) + 8 * 3_600_000, 600)
    insertSession('BV80', dayStart(0) + 20 * 3_600_000, 300)
    insertSession('BV81', dayStart(1) + 10 * 3_600_000, 300)
    insertSession('BV82', dayStart(3) + 10 * 3_600_000, 600)
    insertSession('BV82', dayStart(10) + 10 * 3_600_000, 1200)

    upsertPlayRecord({ bvid: 'BV80' })
    markPlayRecordDone('BV80')
    upsertPlayRecord({ bvid: 'BV81' })
    tickPlayRecord({ bvid: 'BV81', watchedDeltaS: 5, positionS: 5 })
    upsertPlayRecord({ bvid: 'BV82' })
    tickPlayRecord({ bvid: 'BV82', watchedDeltaS: 5, positionS: 5 })
    upsertPlayRecord({ bvid: 'BV83' })

    const s = getProgressStats()
    expect(s.todayMinutes).toBe(15)
    expect(s.weekMinutes).toBe(30) // 15 + 5 + 10
    // 10 天前那条（20 分钟）仅当仍在本月时计入，避免月初运行时用例随日期漂移
    // 昨天 / 3 天前同理：月初运行时也可能落在上月，故逐条按“是否本月”累加
    const now = new Date()
    const inThisMonth = (n: number): boolean => {
      const d = new Date(dayStart(n))
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    }
    const expectedMonth =
      15 + (inThisMonth(1) ? 5 : 0) + (inThisMonth(3) ? 10 : 0) + (inThisMonth(10) ? 20 : 0)
    expect(s.monthMinutes).toBe(expectedMonth)
    expect(s.streakDays).toBe(2) // 今天 + 昨天
    expect(s.weekDaysStudied).toBe(3)
    expect(s.totalCourses).toBe(4)
    expect(s.doneCourses).toBe(1)
    expect(s.learningCourses).toBe(2)
    expect(s.plannedCourses).toBe(1)
    expect(s.dailyGoalMinutes).toBe(90)
    expect(s.weeklyGoalDays).toBe(4)
  })

  it('无数据时返回全零统计（目标取当前设置）', () => {
    // electron-store 为进程内单例，显式设定目标值保证确定性（不受前序用例残留影响）
    setSettings({ 'studyGoals.dailyMinutes': 45, 'studyGoals.weeklyDays': 3 })
    const s = getProgressStats()
    expect(s.todayMinutes).toBe(0)
    expect(s.weekMinutes).toBe(0)
    expect(s.monthMinutes).toBe(0)
    expect(s.streakDays).toBe(0)
    expect(s.weekDaysStudied).toBe(0)
    expect(s.totalCourses).toBe(0)
    expect(s.dailyGoalMinutes).toBe(45)
    expect(s.weeklyGoalDays).toBe(3)
  })
})

/* ================= M4 每日学习时长（柱状图数据） ================= */

describe('getDailyStudyMinutes（M4 柱状图数据）', () => {
  it('近 N 天补零 + 按日期升序聚合，天数钳制', () => {
    const d = getDb()!
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const dayStart = (n: number): number => {
      const dd = new Date(startOfToday)
      dd.setDate(dd.getDate() - n)
      return dd.getTime()
    }
    const insert = (bvid: string, startAt: number, dur: number): void => {
      d.prepare(
        `INSERT INTO study_sessions (bvid, start_at, end_at, duration_s, source, created_at)
         VALUES (?, ?, ?, ?, 'manual', ?)`
      ).run(bvid, startAt, startAt + dur * 1000, dur, Date.now())
    }
    insert('BV90', dayStart(0) + 3_600_000, 600) // 今天 10 分钟
    insert('BV90', dayStart(2) + 3_600_000, 300) // 前天 5 分钟
    insert('BV91', dayStart(0) + 3_600_000, 60) // 今天 1 分钟

    const rows = getDailyStudyMinutes(3)
    expect(rows).toHaveLength(3)
    expect(rows[0].minutes).toBe(5) // 前天
    expect(rows[1].minutes).toBe(0) // 昨天无数据
    expect(rows[2].minutes).toBe(11) // 今天 10 + 1
    // 升序（最旧在前）
    expect(rows[0].date < rows[1].date && rows[1].date < rows[2].date).toBe(true)
    // 天数钳制
    expect(getDailyStudyMinutes(0)).toHaveLength(1)
    expect(getDailyStudyMinutes(200)).toHaveLength(90)
  })
})

/* ================= M5 备份导出 / 导入（数据层） ================= */

describe('exportBackupData / importBackupData（M5 备份恢复）', () => {
  /** 造一份包含记录（含标签/封面/UP主）+ 会话 + 笔记的数据 */
  const seed = (): void => {
    upsertPlayRecord({
      bvid: 'BV100',
      title: '课程A',
      durationS: 600,
      positionS: 300,
      coverUrl: 'c1',
      author: 'UP1'
    })
    setPlayRecordTags('BV100', ['前端'])
    tickPlayRecord({ bvid: 'BV100', watchedDeltaS: 5, positionS: 300 })
    const sid = recordStudySessionStart('BV100', 'resume')
    if (sid) {
      const start = getStudySessionsByVideo('BV100')[0].startAt
      recordStudySessionEnd(sid, start + 5000)
    }
    upsertNote({ id: 'n-b1', createdAt: 1000, content: '笔记1', bvid: 'BV100' })
  }

  it('replace：导出快照 → 清库 → 完整恢复（记录/标签/封面/笔记/会话）', () => {
    seed()
    const data = exportBackupData()
    expect(data.playRecords).toHaveLength(1)
    expect(data.notes).toHaveLength(1)
    expect(data.studySessions).toHaveLength(1)
    expect(data.tags).toEqual(['前端'])
    expect(typeof data.settings.dailyMinutes).toBe('number')

    // 清库
    batchDeletePlayRecords(['BV100'])
    deleteNote('n-b1')
    expect(getPlayRecord('BV100')).toBeNull()

    const result = importBackupData(data, 'replace')
    expect(result.records).toBe(1)
    expect(result.notes).toBe(1)
    expect(result.sessions).toBe(1)
    const rec = getPlayRecord('BV100')
    expect(rec?.title).toBe('课程A')
    expect(rec?.coverUrl).toBe('c1')
    expect(rec?.author).toBe('UP1')
    expect(rec?.tags).toEqual(['前端'])
    expect(loadNotesAll().find((n) => n.id === 'n-b1')?.content).toBe('笔记1')
    expect(getStudySessionsByVideo('BV100')).toHaveLength(1)
    expect(getAllPlayRecordTags()).toEqual(['前端'])
  })

  it('merge：备份中的新记录补入；同 bvid 较旧的备份不覆盖本地；笔记保留现有', async () => {
    seed()
    const data = exportBackupData()
    // 备份里追加一条本地没有的记录
    data.playRecords.push({
      bvid: 'BV102',
      title: '备份新课程',
      durationS: 300,
      watchedS: 120,
      lastPositionS: 60,
      status: 'planned',
      viewedCount: 1,
      goalRounds: 0,
      goalDeadline: '',
      tags: ['后端'],
      coverUrl: '',
      author: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    } satisfies PlayRecord)
    // 本地同 bvid 记录较新
    await new Promise((r) => setTimeout(r, 5))
    updatePlayRecord('BV100', { watchedS: 999, status: 'done' })
    upsertPlayRecord({ bvid: 'BV101', title: '本地课程' })

    const result = importBackupData(data, 'merge')
    expect(result.records).toBe(1) // 仅 BV102 写入（BV100 备份较旧被跳过）
    expect(getPlayRecord('BV100')?.watchedS).toBe(999)
    expect(getPlayRecord('BV100')?.status).toBe('done')
    expect(getPlayRecord('BV101')?.title).toBe('本地课程')
    expect(getPlayRecord('BV102')?.title).toBe('备份新课程')
    expect(getPlayRecord('BV102')?.tags).toEqual(['后端'])
    // 笔记按 id 保留现有
    expect(loadNotesAll().find((n) => n.id === 'n-b1')?.content).toBe('笔记1')
    // 现有标签不被重复写入
    expect(getAllPlayRecordTags()).toContain('前端')
  })

  it('vocab replace：写释义 → 导出 → 清库 → 导入 → listVocab 一致', () => {
    const { entry } = addVocab({
      word: 'serendipity',
      phonetic: '/ˌserənˈdɪpəti/',
      definition: '',
      example: 'a happy accident'
    })
    updateVocabDefinition(entry.id, '意外发现珍宝的能力')
    const data = exportBackupData()
    expect(data.vocab).toHaveLength(1)
    expect(data.vocab?.[0]).toMatchObject({
      word: 'serendipity',
      phonetic: '/ˌserənˈdɪpəti/',
      definition: '意外发现珍宝的能力',
      example: 'a happy accident'
    })

    deleteVocab(entry.id)
    expect(listVocab()).toHaveLength(0)

    const result = importBackupData(data, 'replace')
    expect(result.vocab).toBe(1)
    const restored = listVocab()
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      word: 'serendipity',
      phonetic: '/ˌserənˈdɪpəti/',
      definition: '意外发现珍宝的能力',
      example: 'a happy accident',
      createdAt: data.vocab![0].createdAt
    })
  })

  it('vocab merge：字段级空不盖非空；双方都有则备份优先；仅本地保留', () => {
    addVocab({ word: 'local-only', definition: '仅本地' })
    addVocab({ word: 'keep-local', definition: '本地释义' })
    addVocab({ word: 'fill-from-backup', definition: '' })
    addVocab({
      word: 'prefer-backup',
      phonetic: 'local-ph',
      definition: '本地释义',
      example: 'local-ex'
    })
    addVocab({ word: 'mixed', phonetic: '', definition: '本地释义', example: 'local-ex' })

    const data = exportBackupData()
    data.vocab = [
      {
        id: 0,
        word: 'backup-only',
        phonetic: 'b',
        definition: '仅备份',
        example: '',
        createdAt: 100
      },
      {
        id: 0,
        word: 'keep-local',
        phonetic: '',
        definition: '',
        example: '',
        createdAt: 999
      },
      {
        id: 0,
        word: 'fill-from-backup',
        phonetic: 'f',
        definition: '备份释义',
        example: 'backup-ex',
        createdAt: 50
      },
      {
        id: 0,
        word: 'prefer-backup',
        phonetic: 'backup-ph',
        definition: '备份释义',
        example: 'backup-ex',
        createdAt: 200
      },
      {
        id: 0,
        word: 'mixed',
        phonetic: 'backup-ph',
        definition: '备份释义',
        example: '',
        createdAt: 80
      }
    ]

    const result = importBackupData(data, 'merge')
    expect(result.vocab).toBe(5)
    const byWord = Object.fromEntries(listVocab().map((v) => [v.word, v]))

    expect(byWord['backup-only']).toMatchObject({
      definition: '仅备份',
      phonetic: 'b',
      createdAt: 100
    })
    expect(byWord['local-only']).toMatchObject({ definition: '仅本地' })
    expect(byWord['keep-local']).toMatchObject({ definition: '本地释义' })
    expect(byWord['fill-from-backup']).toMatchObject({
      definition: '备份释义',
      phonetic: 'f',
      example: 'backup-ex'
    })
    expect(byWord['prefer-backup']).toMatchObject({
      phonetic: 'backup-ph',
      definition: '备份释义',
      example: 'backup-ex'
    })
    expect(byWord['mixed']).toMatchObject({
      phonetic: 'backup-ph',
      definition: '备份释义',
      example: 'local-ex'
    })
  })

  it('vocab replace：本地多出的词被清掉；1.1 无 vocab 字段 merge 保留 / replace 清空', () => {
    addVocab({ word: 'stay', definition: '应被清掉' })
    addVocab({ word: 'also', definition: '也应清掉' })
    const snapshot = exportBackupData()
    snapshot.vocab = [
      { id: 0, word: 'from-backup', phonetic: '', definition: '备份词', example: '', createdAt: 1 }
    ]
    const replaced = importBackupData(snapshot, 'replace')
    expect(replaced.vocab).toBe(1)
    expect(listVocab().map((v) => v.word)).toEqual(['from-backup'])

    addVocab({ word: 'local-keep', definition: 'merge 应保留' })
    const legacyNoVocab = {
      playRecords: [],
      notes: [],
      studySessions: [],
      tags: [],
      settings: { dailyMinutes: 0, weeklyDays: 0 }
      // 无 vocab 字段（模拟 1.1）
    }
    const merged = importBackupData(legacyNoVocab, 'merge')
    expect(merged.vocab).toBe(0)
    expect(listVocab().some((v) => v.word === 'local-keep')).toBe(true)

    const cleared = importBackupData(legacyNoVocab, 'replace')
    expect(cleared.vocab).toBe(0)
    expect(listVocab()).toHaveLength(0)
  })
})

/* ================= M5 备份文件层（backup.ts） ================= */

describe('backup.ts 文件层（parseBackupFile / pruneBackups / writeBackupFile）', () => {
  it('parseBackupFile 校验版本与结构；非法文件抛错', () => {
    const valid = buildBackupFile()
    expect(parseBackupFile(JSON.stringify(valid)).version).toBe('1.2')
    expect(parseBackupFile(JSON.stringify(valid)).data.tasks).toEqual([])
    expect(parseBackupFile(JSON.stringify(valid)).data.vocab).toEqual([])
    expect(parseBackupFile(JSON.stringify(valid)).data.playRecords).toEqual([])
    const legacy = {
      version: '1.0',
      exportedAt: 1,
      data: {
        playRecords: [],
        notes: [],
        studySessions: [],
        tags: [],
        settings: { dailyMinutes: 0, weeklyDays: 0 }
      }
    }
    expect(parseBackupFile(JSON.stringify(legacy)).data.tasks).toEqual([])
    expect(parseBackupFile(JSON.stringify(legacy)).data.vocab).toEqual([])
    const legacy11 = {
      version: '1.1',
      exportedAt: 1,
      data: {
        playRecords: [],
        notes: [],
        studySessions: [],
        tags: [],
        settings: { dailyMinutes: 0, weeklyDays: 0 },
        tasks: []
      }
    }
    expect(parseBackupFile(JSON.stringify(legacy11)).data.vocab).toEqual([])
    expect(() => parseBackupFile('not json')).toThrow('不是有效的 JSON')
    expect(() => parseBackupFile(JSON.stringify({ version: '9.9', data: {} }))).toThrow(
      '格式不正确'
    )
  })

  it('pruneBackups 只保留最新的 keepCount 份（文件名时间序）', () => {
    const backupDir = join(dir, 'backup-prune')
    mkdirSync(backupDir, { recursive: true })
    for (const name of [
      'pomodoro-backup-20260101-0300.json',
      'pomodoro-backup-20260102-0300.json',
      'pomodoro-backup-20260103-0300.json',
      'pomodoro-backup-20260104-0300.json',
      'other-file.json'
    ]) {
      writeFileSync(join(backupDir, name), '{}', 'utf-8')
    }
    const removed = pruneBackups(backupDir, 3)
    expect(removed).toBe(1)
    const left = readdirSync(backupDir).sort()
    expect(left).toEqual([
      'other-file.json',
      'pomodoro-backup-20260102-0300.json',
      'pomodoro-backup-20260103-0300.json',
      'pomodoro-backup-20260104-0300.json'
    ])
    // keepCount = 0 → 不清理
    expect(pruneBackups(backupDir, 0)).toBe(0)
  })

  it('writeBackupFile 写文件 + 记录元数据', () => {
    const filePath = join(dir, 'manual-backup.json')
    const meta = writeBackupFile(filePath, buildBackupFile(), 'manual')
    expect(existsSync(filePath)).toBe(true)
    expect(meta.recordCount).toBe(0)
    expect(meta.backupType).toBe('manual')
    const metas = listBackupMeta()
    expect(metas).toHaveLength(1)
    expect(metas[0].filePath).toBe(filePath)
  })
})

describe('学习资源列迁移（旧 bvid 回填为 bili: 键）', () => {
  it('旧进度行保留主键，并补上 resource_key', () => {
    closeDb()
    const { DatabaseSync } = createRequire(__filename)(
      'node:sqlite'
    ) as typeof import('node:sqlite')
    const raw = new DatabaseSync(process.env.POMODORO_DB_PATH!)
    raw.exec(`
      CREATE TABLE play_records (
        bvid TEXT PRIMARY KEY,
        title TEXT DEFAULT '',
        duration_s INTEGER DEFAULT 0,
        watched_s INTEGER DEFAULT 0,
        last_position_s INTEGER DEFAULT 0,
        status TEXT DEFAULT 'planned',
        viewed_count INTEGER DEFAULT 0,
        goal_rounds INTEGER DEFAULT 0,
        goal_deadline TEXT DEFAULT '',
        cover_url TEXT DEFAULT '',
        author TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO play_records (bvid, title, created_at, updated_at) VALUES ('BV1old', '旧课', 1, 1);
    `)
    raw.close()
    const rec = getPlayRecord('BV1old')
    expect(rec?.title).toBe('旧课')
    expect(rec?.resourceKey).toBe('bili:BV1old')
    expect(rec?.resourceType).toBe('bili')
    expect(rec?.sourceUri).toBe('')
    expect(getPlaySourceUri('BV1old')).toBe('')
  })
})
