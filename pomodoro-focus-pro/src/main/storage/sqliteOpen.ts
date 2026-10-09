import { createRequire } from 'module'

/**
 * SQLite 打开逻辑（不依赖 Electron）。
 * 主进程与备份 Worker 各自打开连接；better-sqlite3 连接不能跨线程共享。
 */
export interface SqliteLike {
  pragma(sql: string): unknown
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint }
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  close?(): void
}

/**
 * 打开一个 SQLite 文件并设置 WAL 与 busy_timeout（不建业务表）。
 * 测试驱动：POMODORO_DB_DRIVER=node:sqlite 时使用系统 Node 内置 SQLite
 * （better-sqlite3 按 Electron ABI 编译，纯 Node 的 vitest 无法加载原生绑定）。
 */
export function openSqlite(dbPath: string, opts?: { readonly?: boolean }): SqliteLike {
  const busy = 'PRAGMA busy_timeout = 5000'
  if (process.env.POMODORO_DB_DRIVER === 'node:sqlite') {
    const { DatabaseSync } = createRequire(__filename)(
      'node:sqlite'
    ) as typeof import('node:sqlite')
    const sync = new DatabaseSync(dbPath)
    sync.exec('PRAGMA journal_mode = WAL')
    sync.exec(busy)
    return sync as unknown as SqliteLike
  }
  const require = createRequire(__filename)
  const Database = require('better-sqlite3') as new (
    file: string,
    options?: { readonly?: boolean; fileMustExist?: boolean }
  ) => SqliteLike
  const d = new Database(dbPath, {
    readonly: opts?.readonly === true,
    fileMustExist: opts?.readonly === true
  })
  if (!opts?.readonly) d.pragma('journal_mode = WAL')
  d.pragma('busy_timeout = 5000')
  return d
}
