import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import type { VocabEntry } from '../../shared/ai'
import type { NoteEntry } from '../../shared/bili'
import type { StatsExportFormat, VocabExportFormat } from '../../shared/export'
import {
  listFocusSessionsForExport,
  listStudyStatsForExport,
  listVocab,
  loadNotesAll,
  openSqlite,
  type FocusSessionExportRow,
  type SqliteLike,
  type StudyStatExportRow
} from './db'

const CSV_BOM = '\uFEFF'
const ANKI_DECK_NAME = '静界专注生词本'
const ANKI_TAG = 'pomodoro-vocab'
/** Anki schema 11 的 Basic 模型与牌组使用稳定 id，避免和笔记 id 撞车 */
const ANKI_MODEL_ID = 1607392319000
const ANKI_DECK_ID = 1607392320000
const BASE91 =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-./:;<=>?@[]^_`{|}~'

function csvCell(value: string | number | null | undefined): string {
  if (value == null) return ''
  const text = String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** RFC 4180 CSV，带 UTF-8 BOM，方便 Excel 直接打开中文 */
export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>
): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','))
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`
}

function formatLocal(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function localDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const STATS_HEADERS = ['日期', '模式', '分钟', '番茄数']
const SESSION_HEADERS = [
  'id',
  '模式',
  '锁定等级',
  '开始时间',
  '结束时间',
  '计划秒数',
  '实际秒数',
  '完成番茄',
  '打扰次数',
  '状态',
  '任务ID'
]

function statsRows(stats: StudyStatExportRow[]): Array<Array<string | number>> {
  return stats.map((row) => [row.date, row.mode, row.minutes, row.pomos])
}

function sessionRows(sessions: FocusSessionExportRow[]): Array<Array<string | number>> {
  return sessions.map((row) => [
    row.id,
    row.mode,
    row.level,
    formatLocal(row.startedAt),
    formatLocal(row.endedAt),
    row.durationPlanned,
    row.durationActual,
    row.pomosCompleted,
    row.interruptions,
    row.status,
    row.taskId
  ])
}

export async function buildStatsCsvZip(
  stats: StudyStatExportRow[],
  sessions: FocusSessionExportRow[]
): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('study-stats.csv', toCsv(STATS_HEADERS, statsRows(stats)))
  zip.file('pomodoro-sessions.csv', toCsv(SESSION_HEADERS, sessionRows(sessions)))
  return zip.generateAsync({ type: 'nodebuffer' })
}

export async function buildStatsXlsx(
  stats: StudyStatExportRow[],
  sessions: FocusSessionExportRow[]
): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const statSheet = book.addWorksheet('会话统计')
  statSheet.addRow(STATS_HEADERS)
  for (const row of statsRows(stats)) statSheet.addRow(row)
  const sessionSheet = book.addWorksheet('番茄历史')
  sessionSheet.addRow(SESSION_HEADERS)
  for (const row of sessionRows(sessions)) sessionSheet.addRow(row)
  const out = await book.xlsx.writeBuffer()
  return Buffer.from(out)
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`
}

function noteFileName(note: NoteEntry, used: Set<string>): string {
  const safeId = (note.id || 'note').replace(/[^a-zA-Z0-9_-]/g, '_') || 'note'
  const base = `${localDate(note.createdAt || Date.now())}-${safeId}.md`
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let i = 2
  while (used.has(`${localDate(note.createdAt || Date.now())}-${safeId}-${i}.md`)) i += 1
  const name = `${localDate(note.createdAt || Date.now())}-${safeId}-${i}.md`
  used.add(name)
  return name
}

function noteMarkdown(note: NoteEntry): string {
  const lines = [
    '---',
    `created: ${yamlString(new Date(note.createdAt || Date.now()).toISOString())}`,
    `bvid: ${yamlString(note.bvid ?? '')}`,
    `resourceKey: ${yamlString(note.resourceKey ?? '')}`,
    `videoTitle: ${yamlString(note.videoTitle ?? '')}`,
    `source: ${yamlString(note.source ?? 'main')}`,
    `isKey: ${note.isKey ? 'true' : 'false'}`,
    `timestampS: ${Number(note.timestampS ?? 0)}`,
    '---',
    '',
    note.content ?? ''
  ]
  return lines.join('\n')
}

/** Notion「导入 Markdown」以文件名为页面标题；index.md 只做目录 */
export async function buildNotesMarkdownZip(notes: NoteEntry[]): Promise<Buffer> {
  const zip = new JSZip()
  const used = new Set<string>()
  const links: string[] = []
  for (const note of notes) {
    const name = noteFileName(note, used)
    zip.file(name, noteMarkdown(note))
    links.push(`- [${name}](${name})`)
  }
  const index = links.length > 0 ? `# 笔记\n\n${links.join('\n')}\n` : '# 笔记\n\n（暂无笔记）\n'
  zip.file('index.md', index)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function plainField(value: string): string {
  return value.replace(/[\t\r\n\u001f]/g, ' ')
}

function vocabSides(entry: Pick<VocabEntry, 'word' | 'phonetic' | 'definition' | 'example'>): {
  front: string
  back: string
} {
  const word = escapeHtml(plainField(entry.word))
  const phonetic = escapeHtml(plainField(entry.phonetic))
  const definition = escapeHtml(plainField(entry.definition))
  const example = escapeHtml(plainField(entry.example))
  const front = phonetic ? `${word}<br>${phonetic}` : word
  const back = example ? `${definition}<br><br>${example}` : definition
  return { front, back }
}

export function buildVocabTxt(entries: VocabEntry[]): string {
  const header = [
    '#separator:Tab',
    '#html:true',
    '#notetype:Basic',
    '#deck:静界专注生词本',
    `#columns:Front\tBack\tTags`
  ]
  const lines = entries.map((entry) => {
    const { front, back } = vocabSides(entry)
    return `${front}\t${back}\t${ANKI_TAG}`
  })
  return `${header.join('\n')}\n${lines.join('\n')}${lines.length ? '\n' : ''}`
}

function ankiGuid(): string {
  const bytes = randomBytes(10)
  let guid = ''
  for (let i = 0; i < 10; i += 1) guid += BASE91[bytes[i] % BASE91.length]
  return guid
}

function fieldChecksum(sortField: string): number {
  const hex = createHash('sha1').update(sortField, 'utf8').digest('hex').slice(0, 8)
  return Number.parseInt(hex, 16)
}

function ankiModel(modSec: number): Record<string, unknown> {
  return {
    id: ANKI_MODEL_ID,
    name: 'Basic',
    type: 0,
    mod: modSec,
    usn: -1,
    sortf: 0,
    did: ANKI_DECK_ID,
    tmpls: [
      {
        name: 'Card 1',
        ord: 0,
        qfmt: '{{Front}}',
        afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}',
        bqfmt: '',
        bafmt: '',
        did: null,
        bfont: '',
        bsize: 0
      }
    ],
    flds: [
      { name: 'Front', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      { name: 'Back', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] }
    ],
    css: '.card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n',
    latexPre:
      '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    latexsvg: false,
    req: [[0, 'any', [0]]]
  }
}

function ankiDeck(id: number, name: string, modSec: number): Record<string, unknown> {
  return {
    id,
    mod: modSec,
    name,
    usn: -1,
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: false,
    browserCollapsed: false,
    desc: '',
    dyn: 0,
    conf: 1,
    extendNew: 10,
    extendRev: 50
  }
}

const ANKI_DCONF = {
  id: 1,
  mod: 0,
  name: 'Default',
  usn: 0,
  maxTaken: 60,
  autoplay: true,
  timer: 0,
  replayq: true,
  new: {
    bury: false,
    delays: [1, 10],
    initialFactor: 2500,
    ints: [1, 4, 0],
    order: 1,
    perDay: 20
  },
  rev: {
    bury: false,
    ease4: 1.3,
    ivlFct: 1,
    maxIvl: 36500,
    perDay: 200,
    hardFactor: 1.2
  },
  lapse: {
    delays: [10],
    leechAction: 1,
    leechFails: 8,
    minInt: 1,
    mult: 0
  }
}

const ANKI_SCHEMA = `
CREATE TABLE col (
  id integer PRIMARY KEY,
  crt integer NOT NULL,
  mod integer NOT NULL,
  scm integer NOT NULL,
  ver integer NOT NULL,
  dty integer NOT NULL,
  usn integer NOT NULL,
  ls integer NOT NULL,
  conf text NOT NULL,
  models text NOT NULL,
  decks text NOT NULL,
  dconf text NOT NULL,
  tags text NOT NULL
);
CREATE TABLE notes (
  id integer PRIMARY KEY,
  guid text NOT NULL,
  mid integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  tags text NOT NULL,
  flds text NOT NULL,
  sfld text NOT NULL,
  csum integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE cards (
  id integer PRIMARY KEY,
  nid integer NOT NULL,
  did integer NOT NULL,
  ord integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  type integer NOT NULL,
  queue integer NOT NULL,
  due integer NOT NULL,
  ivl integer NOT NULL,
  factor integer NOT NULL,
  reps integer NOT NULL,
  lapses integer NOT NULL,
  left integer NOT NULL,
  odue integer NOT NULL,
  odid integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE revlog (
  id integer PRIMARY KEY,
  cid integer NOT NULL,
  usn integer NOT NULL,
  ease integer NOT NULL,
  ivl integer NOT NULL,
  lastIvl integer NOT NULL,
  factor integer NOT NULL,
  time integer NOT NULL,
  type integer NOT NULL
);
CREATE TABLE graves (
  usn integer NOT NULL,
  oid integer NOT NULL,
  type integer NOT NULL
);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`

function writeAnkiCollection(db: SqliteLike, entries: VocabEntry[]): void {
  db.exec(ANKI_SCHEMA)
  const nowMs = Date.now()
  const modSec = Math.floor(nowMs / 1000)
  const models = { [String(ANKI_MODEL_ID)]: ankiModel(modSec) }
  const decks = {
    '1': ankiDeck(1, 'Default', modSec),
    [String(ANKI_DECK_ID)]: ankiDeck(ANKI_DECK_ID, ANKI_DECK_NAME, modSec)
  }
  const conf = {
    nextPos: entries.length + 1,
    estTimes: true,
    activeDecks: [ANKI_DECK_ID],
    sortType: 'noteFld',
    timeLim: 0,
    sortBackwards: false,
    addToCur: true,
    curDeck: ANKI_DECK_ID,
    newSpread: 0,
    dueCounts: true,
    curModel: String(ANKI_MODEL_ID),
    collapseTime: 1200
  }
  db.prepare(
    `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
     VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')`
  ).run(
    modSec,
    nowMs,
    nowMs,
    JSON.stringify(conf),
    JSON.stringify(models),
    JSON.stringify(decks),
    JSON.stringify({ '1': ANKI_DCONF })
  )

  const insertNote = db.prepare(
    `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
     VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')`
  )
  const insertCard = db.prepare(
    `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
     VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`
  )
  entries.forEach((entry, index) => {
    const { front, back } = vocabSides(entry)
    const nid = nowMs + index
    const cid = nowMs + entries.length + index
    insertNote.run(
      nid,
      ankiGuid(),
      ANKI_MODEL_ID,
      modSec,
      ` ${ANKI_TAG} `,
      `${front}\u001f${back}`,
      front,
      fieldChecksum(front)
    )
    insertCard.run(cid, nid, ANKI_DECK_ID, modSec, index + 1)
  })
}

/** Anki schema 11 卡包。生产用 better-sqlite3，测试经 openSqlite 走 node:sqlite。 */
export async function buildVocabApkg(entries: VocabEntry[]): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'anki-apkg-'))
  const dbPath = join(dir, 'collection.anki2')
  try {
    const db = openSqlite(dbPath)
    try {
      db.exec('PRAGMA journal_mode = DELETE')
      writeAnkiCollection(db, entries)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close?.()
    }
    const zip = new JSZip()
    zip.file('collection.anki2', readFileSync(dbPath))
    zip.file('media', '{}')
    return await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function renderStatsExport(format: StatsExportFormat): Promise<Buffer> {
  const stats = listStudyStatsForExport()
  const sessions = listFocusSessionsForExport()
  if (format === 'csv') return buildStatsCsvZip(stats, sessions)
  return buildStatsXlsx(stats, sessions)
}

export async function renderNotesMarkdown(): Promise<Buffer> {
  return buildNotesMarkdownZip(loadNotesAll())
}

export async function renderVocabExport(format: VocabExportFormat): Promise<Buffer> {
  const entries = listVocab()
  if (format === 'txt') return Buffer.from(buildVocabTxt(entries), 'utf8')
  return buildVocabApkg(entries)
}
