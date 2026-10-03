import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logger, getLogFilePath } from './logger'

describe('主进程轻量持久化日志工具 logger', () => {
  const testDir = join(tmpdir(), `pomodoro-log-test-${Date.now()}`)

  beforeEach(() => {
    process.env.POMODORO_LOG_DIR = testDir
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    delete process.env.POMODORO_LOG_DIR
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('正常写入各级别日志且包含时间戳和标签', () => {
    logger.info('testTag', '这是一条测试 INFO 日志')
    logger.warn('testTag', '这是一条测试 WARN 日志')
    logger.error('testTag', '这是一条测试 ERROR 日志')

    const logFile = getLogFilePath()
    expect(existsSync(logFile)).toBe(true)

    const content = readFileSync(logFile, 'utf8')
    expect(content).toContain('[INFO] [testTag] 这是一条测试 INFO 日志')
    expect(content).toContain('[WARN] [testTag] 这是一条测试 WARN 日志')
    expect(content).toContain('[ERROR] [testTag] 这是一条测试 ERROR 日志')
  })

  it('支持传入对象作为 extra 字段序列化记录', () => {
    logger.info('apiTest', '请求响应', { code: 0, count: 20 })
    const content = readFileSync(getLogFilePath(), 'utf8')
    expect(content).toContain('{"code":0,"count":20}')
  })

  it('当单文件超过上限时自动轮转为 .1', () => {
    const logFile = getLogFilePath()
    // 写入超过 5MB 数据
    const largeChunk = 'A'.repeat(5 * 1024 * 1024 + 10)
    writeFileSync(logFile, largeChunk, 'utf8')

    // 触发下一次写入
    logger.info('rotateTest', '触发日志轮转')

    expect(existsSync(`${logFile}.1`)).toBe(true)
    const newContent = readFileSync(logFile, 'utf8')
    expect(newContent).toContain('[INFO] [rotateTest] 触发日志轮转')
  })
})
