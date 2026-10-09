import { spawn, type ChildProcess } from 'child_process'

/**
 * L2 守护进程的启动参数。
 * 打包后的主进程没有 ELECTRON_RUN_AS_NODE，也不能假设用户机器上有 node。
 * 用应用自己的可执行文件，并只在子进程环境里打开 ELECTRON_RUN_AS_NODE。
 */
export interface GuardianSpawnPlan {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function planGuardianSpawn(input: {
  execPath: string
  script: string
  pidFile: string
  relaunchExe: string
  relaunchArgs: string[]
  secret: string
  env: NodeJS.ProcessEnv
}): GuardianSpawnPlan {
  return {
    command: input.execPath,
    args: [
      input.script,
      '--watch',
      input.pidFile,
      '--kill-taskmgr',
      '--interval',
      '2000',
      '--relaunch-exe',
      input.relaunchExe,
      '--relaunch-args',
      JSON.stringify(input.relaunchArgs)
    ],
    env: {
      ...input.env,
      ELECTRON_RUN_AS_NODE: '1',
      POMODORO_GUARDIAN_SECRET: input.secret
    }
  }
}

export function spawnGuardianProcess(plan: GuardianSpawnPlan): ChildProcess {
  const child = spawn(plan.command, plan.args, {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    env: plan.env
  })
  // 没有 error 监听时，找不到可执行文件会变成未捕获异常
  child.on('error', () => undefined)
  child.unref()
  return child
}
