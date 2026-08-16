import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 测试环境预置：electron-store 在纯 Node 下必须显式指定 cwd，
 * 这里在测试模块导入前设置 POMODORO_SETTINGS_CWD 指向临时目录，
 * 使 settings 存储落到隔离的临时目录，不影响真实 userData。
 */
process.env.POMODORO_SETTINGS_CWD = mkdtempSync(join(tmpdir(), 'pomodoro-settings-'))
