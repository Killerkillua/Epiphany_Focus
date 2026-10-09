import { spawn, type SpawnOptions } from 'child_process'

/** 当前进程是否 Windows。进程拦截与锁屏只在 win32 上执行。 */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * 启动外部命令并吞掉 ENOENT。
 * 没有 error 监听时，找不到可执行文件会变成未捕获异常（守护进程没有 uncaughtException）。
 */
export function spawnQuiet(command: string, args: string[], extra?: SpawnOptions): void {
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
      ...extra
    })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    /* 同步启动失败同样忽略 */
  }
}
