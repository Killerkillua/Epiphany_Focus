import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/electron-userData' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  addVocab,
  closeDb,
  listVocab,
  openSqlite,
  recordSessionStart,
  recordStudyStats,
  updateVocabDefinition,
  upsertNote
} from './db'
import { renderNotesMarkdown, renderStatsExport, renderVocabExport } from './export'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pomodoro-export-'))
  process.env.POMODORO_DB_PATH = join(dir, 'test.db')
  process.env.POMODORO_DB_DRIVER = 'node:sqlite'
  closeDb()
})

afterEach(() => {
  closeDb()
  delete process.env.POMODORO_DB_PATH
  delete process.env.POMODORO_DB_DRIVER
  rmSync(dir, { recursive: true, force: true })
})

describe('标准化导出', () => {
  it('CSV 压缩包含两份文件，并转义逗号、引号和换行', async () => {
    recordStudyStats('2024-06-01', 'a,"b\nc', 60_000, 1)
    recordSessionStart({
      mode: 'focus',
      level: 'L1',
      startedAt: 1_700_000_000_000,
      durationPlanned: 1500,
      taskId: 'x,y'
    })

    const zip = await JSZip.loadAsync(await renderStatsExport('csv'))
    expect(Object.keys(zip.files).sort()).toEqual(['pomodoro-sessions.csv', 'study-stats.csv'])
    const stats = await zip.file('study-stats.csv')!.async('string')
    const sessions = await zip.file('pomodoro-sessions.csv')!.async('string')
    expect(stats.startsWith('\uFEFF')).toBe(true)
    expect(stats).toContain('"a,""b')
    expect(stats).toContain('c"')
    expect(sessions).toContain('"x,y"')
  })

  it('Excel 含会话统计与番茄历史两个工作表', async () => {
    recordStudyStats('2024-06-01', 'focus', 25 * 60_000, 2)
    recordSessionStart({
      mode: 'focus',
      level: 'L0',
      startedAt: 1_700_000_000_000,
      durationPlanned: 1500,
      taskId: 'task-1'
    })

    const book = new ExcelJS.Workbook()
    // exceljs 的 Buffer 声明和当前 Node Buffer 泛型不一致，测试里按它的入参类型收窄
    const xlsx = Buffer.from(await renderStatsExport('xlsx'))
    await book.xlsx.load(xlsx as unknown as Parameters<typeof book.xlsx.load>[0])
    const stats = book.getWorksheet('会话统计')
    const sessions = book.getWorksheet('番茄历史')
    expect(stats?.rowCount).toBe(2)
    expect(sessions?.rowCount).toBe(2)
    expect(stats?.getRow(2).getCell(2).value).toBe('focus')
    expect(stats?.getRow(2).getCell(3).value).toBe(25)
    expect(sessions?.getRow(2).getCell(11).value).toBe('task-1')
  })

  it('笔记 Markdown 压缩包保留正文换行与 front matter；空库只有 index', async () => {
    const empty = await JSZip.loadAsync(await renderNotesMarkdown())
    expect(Object.keys(empty.files)).toEqual(['index.md'])
    expect(await empty.file('index.md')!.async('string')).toContain('暂无笔记')

    upsertNote({
      id: 'n-1',
      createdAt: Date.UTC(2026, 9, 9, 2),
      content: '第一行\n第二行',
      bvid: 'BV1',
      videoTitle: '标题',
      source: 'main',
      isKey: true,
      timestampS: 12
    })
    const zip = await JSZip.loadAsync(await renderNotesMarkdown())
    const name = Object.keys(zip.files).find((file) => file.endsWith('.md') && file !== 'index.md')
    expect(name).toBeTruthy()
    const text = await zip.file(name!)!.async('string')
    expect(text).toContain('bvid: "BV1"')
    expect(text).toContain('isKey: true')
    expect(text).toContain('第一行\n第二行')
    expect(await zip.file('index.md')!.async('string')).toContain(name!)
  })

  it('生词本 txt 带 Anki 表头，apkg 可解开且笔记数与 media 正确', async () => {
    addVocab({ word: 'apple', phonetic: 'ae', definition: '苹果', example: 'an apple' })
    addVocab({ word: 'pear', phonetic: '', definition: '梨', example: '' })

    const text = (await renderVocabExport('txt')).toString('utf8')
    expect(text).toContain('#separator:Tab')
    expect(text).toContain('#html:true')
    expect(text).toContain('#notetype:Basic')
    expect(text).toContain('#columns:Front\tBack\tTags')
    expect(text).toContain('apple<br>ae\t苹果<br><br>an apple\tpomodoro-vocab')
    expect(text).toContain('pear\t梨\tpomodoro-vocab')

    const zip = await JSZip.loadAsync(await renderVocabExport('apkg'))
    expect(await zip.file('media')!.async('string')).toBe('{}')
    const dbPath = join(dir, 'collection.anki2')
    writeFileSync(dbPath, await zip.file('collection.anki2')!.async('nodebuffer'))
    const sqlite = openSqlite(dbPath)
    try {
      const row = sqlite.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number | bigint }
      expect(Number(row.c)).toBe(2)
    } finally {
      sqlite.close?.()
    }
  })

  it('重复加入同一生词时保留已有释义，update 只改释义', () => {
    const first = addVocab({
      word: 'apple',
      phonetic: 'ae',
      definition: '苹果',
      example: 'an apple'
    })
    const again = addVocab({ word: 'apple', definition: '', phonetic: '', example: '' })
    expect(first.existed).toBe(false)
    expect(again.existed).toBe(true)
    expect(again.entry.definition).toBe('苹果')
    expect(again.entry.phonetic).toBe('ae')
    expect(again.entry.example).toBe('an apple')

    const updated = updateVocabDefinition(again.entry.id, '一种水果')
    expect(updated?.definition).toBe('一种水果')
    expect(updated?.phonetic).toBe('ae')
    expect(updated?.example).toBe('an apple')
    expect(listVocab()).toHaveLength(1)
    expect(updateVocabDefinition(again.entry.id, '一种水果')?.definition).toBe('一种水果')
    expect(updateVocabDefinition(again.entry.id + 99, '不存在')).toBeNull()
  })
})
