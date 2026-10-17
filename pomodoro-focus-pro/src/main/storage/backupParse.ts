import { readFileSync, statSync } from 'fs'
import { BACKUP_VERSIONS, type BackupFile } from '../../shared/backup'

/** 解析并校验备份文件（version + 必填字段），非法抛错 */
export function parseBackupFile(text: string): BackupFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('备份文件不是有效的 JSON')
  }
  const file = json as BackupFile
  if (
    !file ||
    typeof file !== 'object' ||
    !(BACKUP_VERSIONS as readonly string[]).includes(file.version) ||
    !file.data ||
    !Array.isArray(file.data.playRecords) ||
    !Array.isArray(file.data.notes) ||
    !Array.isArray(file.data.studySessions)
  ) {
    throw new Error(
      '备份文件格式不正确或版本不受支持（需要 version ' + BACKUP_VERSIONS.join(' / ') + '）'
    )
  }
  return { ...file, data: sanitizeBackupData(file.data) }
}

/* ===== 备份内容清洗（备份文件是不可信输入：限制规模、统一字段类型与长度） ===== */

/** 备份文件大小上限（超过直接拒绝读取） */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024
const MAX_RECORDS = 50_000
const MAX_NOTES = 100_000
const MAX_SESSIONS = 200_000
const MAX_TASKS = 20_000
const MAX_VOCAB = 50_000

const asStr = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const asNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
const asObj = (v: unknown, label: string, i: number): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`备份文件损坏：${label}[${i}] 不是对象`)
  }
  return v as Record<string, unknown>
}

function sanitizeBackupData(data: BackupFile['data']): BackupFile['data'] {
  const tasksIn = Array.isArray(data.tasks) ? data.tasks : []
  const focusIn = Array.isArray(data.focusSessions) ? data.focusSessions : []
  const eventsIn = Array.isArray(data.interruptionEvents) ? data.interruptionEvents : []
  const vocabIn = Array.isArray(data.vocab) ? data.vocab : []
  if (
    data.playRecords.length > MAX_RECORDS ||
    data.notes.length > MAX_NOTES ||
    data.studySessions.length > MAX_SESSIONS ||
    tasksIn.length > MAX_TASKS ||
    focusIn.length > MAX_SESSIONS ||
    eventsIn.length > MAX_SESSIONS ||
    vocabIn.length > MAX_VOCAB
  ) {
    throw new Error('备份文件条目数量超出上限')
  }
  const playRecords = data.playRecords.map((raw, i) => {
    const r = asObj(raw, 'playRecords', i)
    const bvid = asStr(r.bvid, 100)
    if (!bvid) throw new Error(`备份文件损坏：playRecords[${i}] 缺少 bvid`)
    const tags = Array.isArray(r.tags)
      ? r.tags
          .slice(0, 100)
          .map((t) => asStr(t, 50))
          .filter(Boolean)
      : []
    return {
      bvid,
      title: asStr(r.title, 1000),
      durationS: asNum(r.durationS),
      watchedS: asNum(r.watchedS),
      lastPositionS: asNum(r.lastPositionS),
      status: asStr(r.status, 20) as BackupFile['data']['playRecords'][number]['status'],
      viewedCount: asNum(r.viewedCount),
      goalRounds: asNum(r.goalRounds),
      goalDeadline: asStr(r.goalDeadline, 50),
      createdAt: asNum(r.createdAt),
      updatedAt: asNum(r.updatedAt),
      tags,
      coverUrl: asStr(r.coverUrl, 2000),
      author: asStr(r.author, 500)
    }
  })
  const notes = data.notes.map((raw, i) => {
    const n = asObj(raw, 'notes', i)
    return {
      id: asStr(n.id, 200),
      createdAt: asNum(n.createdAt),
      content: asStr(n.content, 200_000),
      bvid: asStr(n.bvid, 100) || undefined,
      videoTitle: asStr(n.videoTitle, 1000) || undefined,
      timestampS: n.timestampS === undefined ? undefined : asNum(n.timestampS),
      isKey: n.isKey === true,
      source: asStr(n.source, 20) as BackupFile['data']['notes'][number]['source']
    }
  })
  const studySessions = data.studySessions.map((raw, i) => {
    const s = asObj(raw, 'studySessions', i)
    return {
      id: asNum(s.id),
      bvid: asStr(s.bvid, 100),
      startAt: asNum(s.startAt),
      endAt: asNum(s.endAt),
      durationS: asNum(s.durationS),
      source: asStr(s.source, 20) as BackupFile['data']['studySessions'][number]['source'],
      createdAt: asNum(s.createdAt)
    }
  })
  return {
    playRecords,
    notes,
    studySessions,
    tags: Array.isArray(data.tags)
      ? data.tags
          .slice(0, 10_000)
          .map((t) => asStr(t, 50))
          .filter(Boolean)
      : [],
    settings: {
      dailyMinutes: asNum(data.settings?.dailyMinutes),
      weeklyDays: asNum(data.settings?.weeklyDays)
    },
    tasks: tasksIn.map((raw, i) => {
      const t = asObj(raw, 'tasks', i)
      const id = asStr(t.id, 80)
      if (!id) throw new Error(`备份文件损坏：tasks[${i}] 缺少 id`)
      const priority = asStr(t.priority, 20)
      const status = asStr(t.status, 20)
      return {
        id,
        title: asStr(t.title, 200) || '未命名任务',
        priority: (priority === 'high' || priority === 'low' ? priority : 'medium') as
          | 'high'
          | 'medium'
          | 'low',
        estimatedPomodoros: asNum(t.estimatedPomodoros),
        actualPomodoros: asNum(t.actualPomodoros),
        status: (status === 'done' || status === 'archived' ? status : 'todo') as
          | 'todo'
          | 'done'
          | 'archived',
        sortOrder: asNum(t.sortOrder),
        createdAt: asNum(t.createdAt),
        updatedAt: asNum(t.updatedAt),
        completedAt: t.completedAt == null ? null : asNum(t.completedAt)
      }
    }),
    focusSessions: focusIn.map((raw, i) => {
      const s = asObj(raw, 'focusSessions', i)
      return {
        id: asNum(s.id),
        taskId: asStr(s.taskId, 80) || null,
        level: asStr(s.level, 8) || 'L0',
        startedAt: asNum(s.startedAt),
        endedAt: s.endedAt == null ? null : asNum(s.endedAt),
        durationPlanned: asNum(s.durationPlanned),
        durationActual: asNum(s.durationActual),
        pomosCompleted: asNum(s.pomosCompleted),
        interruptions: asNum(s.interruptions),
        internalInterruptions: asNum(s.internalInterruptions),
        externalInterruptions: asNum(s.externalInterruptions),
        status: asStr(s.status, 32) || 'done',
        pomoCredited: s.pomoCredited === true
      }
    }),
    interruptionEvents: eventsIn.map((raw, i) => {
      const e = asObj(raw, 'interruptionEvents', i)
      return {
        id: asStr(e.id, 80),
        sessionId: asNum(e.sessionId),
        taskId: asStr(e.taskId, 80) || null,
        type: (asStr(e.type, 20) === 'external' ? 'external' : 'internal') as
          | 'internal'
          | 'external',
        note: asStr(e.note, 120),
        elapsedMs: asNum(e.elapsedMs),
        createdAt: asNum(e.createdAt)
      }
    }),
    vocab: vocabIn.map((raw, i) => {
      const v = asObj(raw, 'vocab', i)
      const word = asStr(v.word, 200).trim()
      if (!word) throw new Error(`备份文件损坏：vocab[${i}] 缺少 word`)
      return {
        id: asNum(v.id),
        word,
        phonetic: asStr(v.phonetic, 200),
        definition: asStr(v.definition, 2000),
        example: asStr(v.example, 2000),
        createdAt: asNum(v.createdAt)
      }
    })
  }
}

/** 读取备份文件（手动导入用） */
export function readBackupFile(filePath: string): BackupFile {
  if (statSync(filePath).size > MAX_BACKUP_BYTES) {
    throw new Error('备份文件过大（超过 50MB）')
  }
  return parseBackupFile(readFileSync(filePath, 'utf-8'))
}

