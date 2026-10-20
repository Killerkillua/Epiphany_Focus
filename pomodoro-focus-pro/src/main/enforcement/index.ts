import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { spawn } from 'child_process'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { randomBytes, createHmac } from 'crypto'
import { join } from 'path'
import { IPC_CHANNELS, IPC_EVENTS } from '../../shared/ipc'
import { TimerService } from '../timer'
import { getSettings, setSettings } from '../storage/settings'
import { recordSessionEnd, recordSessionStart, recordStudyStats, todayLocal } from '../storage/db'
import {
  addInterruption,
  creditFocusPomodoro,
  getFocusSessionContext,
  getTask,
  updateInterruptionNote
} from '../storage/taskRepository'
import { isEnforcedLevel, LEVEL_CAPS } from './level'
import { verifyCurrentPassword } from '../auth'
import * as emergency from './emergencyExit'
import { registerShortcutGuard, unregisterShortcutGuard } from './shortcutGuard'
import { WindowGuard } from './windowGuard'
import { startTaskmgrKill, stopTaskmgrKill } from './processGuard'
import { applyLevelWindow, releaseLevelWindow, lockWorkstation } from './lockScreen'
import { ValidationError, str, num, bool, arr, oneOf } from '../validate'
import type { DistractionPolicy, TimerMode, TimerOptions, TimerSnapshot } from '../../shared/types'
import type { EmergencyExitResult, LockLevel } from '../../shared/settings'

/**
 * 强制引擎（方案 2.5/2.10/3.3）：
 * - 专注会话开始 → 按锁定级别施加强制（遮罩/快捷键/守卫/守护进程）
 * - 会话结束 → 记录 sessions + study_stats
 * - 紧急退出：恢复码 bcrypt 验证 + 冷却 + 会话上限
 * - enforced 状态持久化：重启后自动恢复（防重启绕过）
 */

interface ActiveSession {
  level: LockLevel
  mode: string
  startedAt: number
  sessionId: number
  taskId: string | null
  taskTitle: string | null
  timerMode: TimerMode
  internalInterruptions: number
  externalInterruptions: number
}

const DEFAULT_POLICY: DistractionPolicy = { enabled: false, blacklist: [], whitelist: [] }

/**
 * 强制引擎外部依赖（CR-05：由装配层注入，enforcement 不再反向 import navigation）。
 * 依赖方向约定：navigation → enforcement；enforcement 需要导航能力时经此回调获取。
 */
export interface EnforcementDeps {
  /** 紧急退出时销毁 学习视频窗口（由主进程入口注入 closeVideo 实现） */
  closeVideo?: () => void
}

/** 强制引擎句柄（供导航模块接入） */
export interface EnforcementHandle {
  restoreAfterRestart: () => void
  /** 打开 学习视频时启动强制会话（正向计时 + 会话上限） */
  enterBiliSession: (videoWin: BrowserWindow, opts: { plannedMs: number; topic: string }) => void
  /** 关闭 学习视频时结束强制会话并落库 */
  exitBiliSession: (reason: 'manual' | 'completed' | 'emergency') => void
  /**
   * 登记"失焦拉回豁免"窗口（视频学习悬浮面板）：用户与面板交互（点击 / 输入）导致
   * 视频窗口失焦时，不执行 show()+focus() 抢回，保证面板可用。
   */
  setOverlayExempt: (win: BrowserWindow | null) => void
  /**
   * 暂停 / 恢复窗口守卫的失焦拉回（P-2：紧急退出弹窗打开期间暂停，
   * 避免视频窗口把焦点抢回，用户输入不了恢复码）。
   */
  setPullBackPaused: (paused: boolean) => void
}

export function registerEnforcementModule(
  getWindow: () => BrowserWindow | null,
  deps: EnforcementDeps = {}
): EnforcementHandle {
  const timer = new TimerService(
    (snap) => {
      getWindow()?.webContents.send(IPC_EVENTS.timer.tick, enrich(snap))
    },
    (snap) => {
      const next = enrich(snap)
      getWindow()?.webContents.send(IPC_EVENTS.timer.complete, next)
      onTimerComplete(next)
    }
  )

  function enrich(snap: TimerSnapshot): TimerSnapshot {
    return {
      ...snap,
      sessionId: active?.sessionId ?? null,
      taskId: active?.taskId ?? null,
      taskTitle: active?.taskTitle ?? null,
      internalInterruptions: active?.internalInterruptions ?? 0,
      externalInterruptions: active?.externalInterruptions ?? 0
    }
  }

  function publish(snap: TimerSnapshot): TimerSnapshot {
    const next = enrich(snap)
    getWindow()?.webContents.send(IPC_EVENTS.timer.tick, next)
    return next
  }

  const windowGuard = new WindowGuard()
  let active: ActiveSession | null = null
  let guardian: ReturnType<typeof spawn> | null = null
  let lastPomos = 0
  let currentPolicy: DistractionPolicy = { ...DEFAULT_POLICY }
  /** 视频学习悬浮面板窗口：失焦拉回豁免对象（面板交互时视频窗口不抢焦点） */
  let overlayExemptWindow: BrowserWindow | null = null
  /** 主进程 5×Esc 兜底检测处理器（主窗口强制会话专用，学习视频窗口由 fullscreenLock.ts 负责） */
  let escSpamHandler: ((_e: Electron.Event, input: Electron.Input) => void) | null = null

  /** 失焦拉回豁免判定：当前聚焦窗口是悬浮面板时不拉回视频窗口 */
  const overlayExempt = (focused: BrowserWindow | null): boolean =>
    overlayExemptWindow !== null && focused === overlayExemptWindow

  // ================= 强制会话生命周期 =================

  function beginEnforcement(
    mode: string,
    plannedMs: number,
    target?: BrowserWindow,
    link?: { taskId: string | null; taskTitle: string | null; timerMode: TimerMode }
  ): void {
    const level = getSettings().lockLevel
    // L1/L2 前置：必须已设置恢复码（安全兜底，方案 2.10）
    emergency.assertExitSafety(level)

    const win = target ?? getWindow()
    if (!win) return
    const sessionId =
      recordSessionStart({
        mode,
        level,
        startedAt: Date.now(),
        durationPlanned: plannedMs,
        taskId: link?.taskId ?? null
      }) ?? 0

    // 按锁定级别能力施加强制：L0 仅置顶，L1/L2 才施加全屏遮罩（LEVEL_CAPS[level].fullscreenOverlay）
    if (LEVEL_CAPS[level].fullscreenOverlay) {
      // 视频学习模式：视频窗口不设置顶（悬浮面板须浮于视频之上；全屏由 attachFullscreenLock 管理），
      // 其余锁定属性（禁缩放 / 隐藏任务栏 / 拦截关闭）照常施加
      applyLevelWindow(win, { skipAlwaysOnTop: mode === 'bili' })
      // 主窗口 L1/L2 强制会话：主进程兜底 5×Esc 检测（3 秒窗口）
      // 渲染层也有 keydown 检测，但全屏时主进程兜底更可靠（与 fullscreenLock.ts 学习视频窗口对齐）
      if (mode !== 'bili') {
        const ESC_COUNT = 5
        const ESC_WINDOW_MS = 3000
        let escTimes: number[] = []
        escSpamHandler = (_e, input): void => {
          if (!active || input.key !== 'Escape') return
          const now = Date.now()
          escTimes = [...escTimes.filter((t) => now - t < ESC_WINDOW_MS), now]
          if (escTimes.length >= ESC_COUNT) {
            escTimes = []
            // 通知渲染层唤起紧急退出弹窗（复用 bili.emergencyRequest 事件，弹窗是通用的）
            getWindow()?.webContents.send(IPC_EVENTS.bili.emergencyRequest)
          }
          // 消费单次 Esc：防止系统退全屏触发"退出→拉回"闪烁（与 assertFullscreen 三重兜底配合）
          _e.preventDefault()
        }
        win.webContents.on('before-input-event', escSpamHandler)
      }
    } else if (LEVEL_CAPS[level].alwaysOnTop && mode !== 'bili') {
      // L0 轻量级别：仅置顶，不进入全屏遮罩（bili 模式跳过置顶，与 L1/L2 一致）
      win.setAlwaysOnTop(true)
    }
    if (LEVEL_CAPS[level].globalShortcuts) registerShortcutGuard()
    windowGuard.start(win, level, currentPolicy, { exemptFromPullBack: overlayExempt })
    if (LEVEL_CAPS[level].killTaskmgr) startTaskmgrKill()
    if (LEVEL_CAPS[level].guardian) spawnGuardian()

    active = {
      level,
      mode,
      startedAt: Date.now(),
      sessionId,
      taskId: link?.taskId ?? null,
      taskTitle: link?.taskTitle ?? null,
      timerMode: link?.timerMode ?? (mode === 'focus' ? 'countdown' : 'countup'),
      internalInterruptions: 0,
      externalInterruptions: 0
    }
    lastPomos = timer.getSnapshot().completedPomodoros
    setSettings({
      enforced: {
        active: true,
        level,
        mode,
        startedAt: active.startedAt,
        plannedMs,
        sessionId,
        taskId: active.taskId,
        taskTitle: active.taskTitle,
        timerMode: active.timerMode
      }
    })
  }

  function endEnforcement(
    reason: 'manual' | 'completed' | 'emergency' | 'expired',
    target?: BrowserWindow
  ): void {
    const win = target ?? getWindow()
    // 在 active 置空前保存 level（用于后续 L0 置顶还原等判定）
    const level = active ? active.level : getSettings().lockLevel
    if (active) {
      const after = timer.getSnapshot()
      const status = after.completedPomodoros > lastPomos ? 'done' : 'abandoned'
      recordSessionEnd(active.sessionId, {
        durationActual: after.elapsedMs,
        pomosCompleted: Math.max(0, after.completedPomodoros - lastPomos),
        interruptions: 0,
        status: reason === 'emergency' ? 'emergency_exit' : status
      })
      active = null
    }
    if (win && !win.isDestroyed()) {
      releaseLevelWindow(win)
      // L0 轻量级别：beginEnforcement 中直接 setAlwaysOnTop(true)，此处对称还原
      if (!LEVEL_CAPS[level].fullscreenOverlay && LEVEL_CAPS[level].alwaysOnTop) {
        win.setAlwaysOnTop(false)
      }
    }
    // P-2：紧急退出兜底销毁 学习视频窗口——video.destroy() 绕过 applyLevelWindow 的
    // close 拦截，销毁后 'closed' 事件自动清理其遮罩引用计数，
    // 避免紧急退出成功后视频窗口仍保持全屏 + 拦截关闭 + 隐藏任务栏，把用户困在全屏
    if (reason === 'emergency') {
      try {
        deps.closeVideo?.()
      } catch {
        /* 忽略 */
      }
    }
    unregisterShortcutGuard()
    windowGuard.stop()
    stopTaskmgrKill()
    stopGuardian()
    // 清理主进程 5×Esc 兜底检测（主窗口强制会话）
    if (escSpamHandler && win && !win.isDestroyed()) {
      win.webContents.removeListener('before-input-event', escSpamHandler)
      escSpamHandler = null
    }
    setSettings({ enforced: null })
    if (reason === 'emergency' && LEVEL_CAPS[getSettings().lockLevel].guardian) {
      emergency.startL2CoolDown()
    }
  }

  /** 到点：记录统计 + 按"到点动作"执行（方案 4.2） */
  function onTimerComplete(snap: TimerSnapshot): void {
    // 仅倒计时自然到点计入任务番茄；正序手动结束不走这条路径。
    if (active?.mode === 'focus' && active.timerMode === 'countdown' && active.sessionId) {
      creditFocusPomodoro(active.sessionId, snap.elapsedMs)
    }
    // 分钟换算统一在 recordStudyStats 内完成（毫秒入参）
    recordStudyStats(todayLocal(), active?.mode ?? 'focus', snap.elapsedMs, 1)
    lastPomos = snap.completedPomodoros
    if (getSettings().endAction === 'lock') {
      lockWorkstation()
    }
    // overlay：保持全屏遮罩（完成态 UI）；notify：仅通知（已完成推送）
  }

  // ================= L2 守护进程 =================

  function spawnGuardian(): void {
    try {
      if (guardian) return
      const pidFile = join(app.getPath('userData'), 'enforced.pid')
      // H-04：PID 文件附 HMAC 签名（密钥经环境变量传给守护进程），
      // 防止本地程序伪造 pid 文件触发守护进程任意拉起。
      const secret = randomBytes(32).toString('hex')
      const signature = createHmac('sha256', secret).update(String(process.pid)).digest('hex')
      writeFileSync(pidFile, `${process.pid}\n${signature}`)
      const script = join(__dirname, 'guardian.js')
      if (!existsSync(script)) {
        console.warn('[enforcement] guardian.js 未构建，L2 守护能力降级（跳过拉起）')
        return
      }
      // H-04：relaunch 目标改为显式 exe + 参数数组（不经 shell），杜绝任意命令执行。
      // 打包态：应用可执行文件直接拉起；开发态：electron + 应用目录。
      const relaunchExe = process.execPath
      const relaunchArgs = app.isPackaged ? [] : [app.getAppPath()]
      // 独立 Node 进程（模拟系统服务行为；真实 Windows Service 注册见 guardian.ts --install-service）
      guardian = spawn(
        process.env.ELECTRON_RUN_AS_NODE ? process.execPath : 'node',
        [
          script,
          '--watch',
          pidFile,
          '--kill-taskmgr',
          '--interval',
          '2000',
          '--relaunch-exe',
          relaunchExe,
          '--relaunch-args',
          JSON.stringify(relaunchArgs)
        ],
        {
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
          env: { ...process.env, POMODORO_GUARDIAN_SECRET: secret }
        }
      )
      guardian.unref()
    } catch (err) {
      console.warn('[enforcement] 守护进程拉起失败:', err instanceof Error ? err.message : err)
    }
  }

  function stopGuardian(): void {
    if (guardian) {
      try {
        guardian.kill()
      } catch {
        // 忽略
      }
      guardian = null
    }
    try {
      unlinkSync(join(app.getPath('userData'), 'enforced.pid'))
    } catch {
      // 文件不存在忽略
    }
  }

  // ================= 重启恢复（防重启绕过） =================

  function restoreAfterRestart(): void {
    const enforced = getSettings().enforced
    if (!enforced?.active) return
    const win = getWindow()
    if (!win) return

    const elapsedMs = Date.now() - enforced.startedAt
    const remainingMs = enforced.plannedMs - elapsedMs

    if (remainingMs <= 0) {
      // 离线期间已到期：倒计时专注才结算任务番茄（幂等，重复启动不会再加）
      if (
        enforced.mode === 'focus' &&
        (enforced.timerMode ?? 'countdown') === 'countdown' &&
        enforced.sessionId
      ) {
        creditFocusPomodoro(enforced.sessionId, enforced.plannedMs)
      }
      // 离线期间已到期：记为完成并解除
      recordStudyStats(todayLocal(), enforced.mode, enforced.plannedMs, 1)
      if (enforced.sessionId) {
        recordSessionEnd(enforced.sessionId, {
          durationActual: enforced.plannedMs,
          pomosCompleted: 1,
          interruptions: 0,
          status: 'done'
        })
      }
      setSettings({ enforced: null })
      new Notification({
        title: '🍅 强制会话已到期',
        body: '应用离线期间专注计时已自动完成。',
        silent: true
      }).show()
      return
    }

    // 恢复：施加级别 + 续时（单调时钟剩余量）。
    // 与 beginEnforcement 对齐：bili 模式跳过置顶（悬浮面板须浮于视频之上）、
    // 登记失焦拉回豁免，避免重启恢复后的强制配置与运行时不一致
    if (LEVEL_CAPS[enforced.level].fullscreenOverlay) {
      applyLevelWindow(win, { skipAlwaysOnTop: enforced.mode === 'bili' })
      // 重启恢复：主进程兜底 5×Esc 检测（与 beginEnforcement 对齐）
      if (enforced.mode !== 'bili') {
        const ESC_COUNT = 5
        const ESC_WINDOW_MS = 3000
        let escTimes: number[] = []
        escSpamHandler = (_e, input): void => {
          if (!active || input.key !== 'Escape') return
          const now = Date.now()
          escTimes = [...escTimes.filter((t) => now - t < ESC_WINDOW_MS), now]
          if (escTimes.length >= ESC_COUNT) {
            escTimes = []
            getWindow()?.webContents.send(IPC_EVENTS.bili.emergencyRequest)
          }
          _e.preventDefault()
        }
        win.webContents.on('before-input-event', escSpamHandler)
      }
    } else if (LEVEL_CAPS[enforced.level].alwaysOnTop && enforced.mode !== 'bili') {
      win.setAlwaysOnTop(true)
    }
    if (LEVEL_CAPS[enforced.level].globalShortcuts) registerShortcutGuard()
    windowGuard.start(win, enforced.level, currentPolicy, { exemptFromPullBack: overlayExempt })
    if (LEVEL_CAPS[enforced.level].killTaskmgr) startTaskmgrKill()
    if (LEVEL_CAPS[enforced.level].guardian) spawnGuardian()

    const timerMode = enforced.timerMode ?? 'countdown'
    timer.restore({ mode: timerMode, durationMs: enforced.plannedMs, elapsedMs })
    const ctx = getFocusSessionContext(enforced.sessionId)
    active = {
      level: enforced.level,
      mode: enforced.mode,
      startedAt: enforced.startedAt,
      sessionId: enforced.sessionId,
      taskId: enforced.taskId ?? ctx?.taskId ?? null,
      taskTitle: enforced.taskTitle ?? ctx?.taskTitle ?? null,
      timerMode,
      internalInterruptions: ctx?.internalInterruptions ?? 0,
      externalInterruptions: ctx?.externalInterruptions ?? 0
    }
    lastPomos = timer.getSnapshot().completedPomodoros
    new Notification({
      title: '🔒 已恢复强制会话',
      body: `剩余 ${Math.ceil(remainingMs / 60_000)} 分钟（级别 ${enforced.level}）。`,
      silent: true
    }).show()
  }

  // ================= IPC 注册 =================

  // ---- 计时通道（专注模式，会话开始/结束联动强制引擎） ----
  ipcMain.handle(IPC_CHANNELS.timer.start, (_event, options: TimerOptions) => {
    // H-01：运行时校验计时参数（mode 白名单 + durationMs 有限非负）
    const opts = options ?? ({} as TimerOptions)
    const mode = oneOf(opts.mode, 'timer.mode', ['countdown', 'countup'] as const)
    if (!mode) throw new ValidationError('timer.mode 必须是 countdown/countup')
    const durationMs = num(opts.durationMs, 'timer.durationMs')
    if (durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) {
      throw new ValidationError('timer.durationMs 超出允许范围')
    }
    let taskId: string | null = null
    let taskTitle: string | null = null
    if (opts.taskId != null && opts.taskId !== '') {
      taskId = str(opts.taskId, 'timer.taskId', { max: 80 })
      const task = getTask(taskId)
      if (!task || task.status !== 'todo') {
        throw new ValidationError('只能关联未完成的任务')
      }
      taskTitle = task.title
    }
    beginEnforcement('focus', durationMs, undefined, { taskId, taskTitle, timerMode: mode })
    return enrich(timer.start({ mode, durationMs }))
  })

  ipcMain.handle(IPC_CHANNELS.timer.stop, () => {
    const before = timer.getSnapshot()
    // CR-01：强制会话（L1/L2）中禁止通过 timer:stop 直接解除强制——
    // 若渲染进程被攻破，一行调用即可绕过全部强制机制。正常路径只能走紧急退出码。
    // 例外：计时已自然完成（status === 'finished'）时结束会话属正常流程（到点收尾）。
    if (active && isEnforcedLevel(active.level) && before.status !== 'finished') {
      throw new Error('强制会话中请使用紧急退出码（连按 5 次 Esc）结束')
    }
    const result = timer.stop()
    // 正序手动结束计数的一段，补记统计（逆序到点已由 complete 记录）
    if (result.completedPomodoros > before.completedPomodoros) {
      recordStudyStats(todayLocal(), 'focus', result.elapsedMs, 1)
    }
    endEnforcement('manual')
    return enrich(result)
  })

  ipcMain.handle(IPC_CHANNELS.timer.pause, () => enrich(timer.pause()))
  ipcMain.handle(IPC_CHANNELS.timer.resume, () => enrich(timer.resume()))
  ipcMain.handle(IPC_CHANNELS.timer.getState, () => enrich(timer.getSnapshot()))

  ipcMain.handle(
    IPC_CHANNELS.interruptions.add,
    (_event, payload: { type?: string; note?: string }) => {
      if (!active || active.mode !== 'focus' || !active.sessionId) {
        throw new ValidationError('当前没有进行中的专注会话')
      }
      const status = timer.getSnapshot().status
      if (status !== 'running' && status !== 'paused') {
        throw new ValidationError('当前不能记录打扰')
      }
      const type = oneOf(payload?.type, 'interruption.type', ['internal', 'external'] as const)
      if (!type) throw new ValidationError('interruption.type 必须是 internal / external')
      const note =
        payload?.note == null || payload.note === ''
          ? ''
          : str(payload.note, 'interruption.note', { max: 120, allowEmpty: true })
      const event = addInterruption({
        sessionId: active.sessionId,
        taskId: active.taskId,
        type,
        note,
        elapsedMs: timer.getSnapshot().elapsedMs
      })
      if (!event) throw new Error('记录打扰失败')
      if (type === 'internal') active.internalInterruptions += 1
      else active.externalInterruptions += 1
      return { eventId: event.id, snapshot: publish(timer.getSnapshot()) }
    }
  )

  ipcMain.handle(IPC_CHANNELS.interruptions.updateNote, (_event, id: string, note: string) => {
    if (!active?.sessionId) throw new ValidationError('当前没有进行中的专注会话')
    const eventId = str(id ?? '', 'interruption.id', { max: 80 })
    const text = str(note ?? '', 'interruption.note', { max: 120, allowEmpty: true })
    if (!updateInterruptionNote(eventId, active.sessionId, text)) {
      throw new ValidationError('打扰记录不存在')
    }
    return true
  })

  // ---- 强制通道 ----
  ipcMain.handle(IPC_CHANNELS.enforce.setAlwaysOnTop, (_event, on: boolean) => {
    getWindow()?.setAlwaysOnTop(bool(on, 'enforce.alwaysOnTop'))
    return on === true
  })

  ipcMain.handle(
    IPC_CHANNELS.enforce.applyDistractionPolicy,
    (_event, policy: DistractionPolicy): DistractionPolicy => {
      // H-01：运行时校验策略结构（blacklist/whitelist 必须是字符串数组，防 undefined.map 崩溃）
      const p = policy ?? ({} as DistractionPolicy)
      const enabled = bool(p.enabled, 'policy.enabled')
      const blacklist = arr(p.blacklist, 'policy.blacklist', { itemString: true }) as string[]
      const whitelist = arr(p.whitelist, 'policy.whitelist', { itemString: true }) as string[]
      const safe: DistractionPolicy = { enabled, blacklist, whitelist }
      currentPolicy = safe
      if (active) {
        const win = getWindow()
        if (win) windowGuard.start(win, active.level, safe, { exemptFromPullBack: overlayExempt })
      }
      return safe
    }
  )

  ipcMain.handle(IPC_CHANNELS.enforce.lock, (_event, mode: string): boolean => {
    beginEnforcement(typeof mode === 'string' ? mode : 'focus', timer.getSnapshot().durationMs)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.enforce.unlock, (): boolean => {
    // CR-01：强制会话（L1/L2）中禁用直接解锁，仅允许通过紧急退出码触发。
    // 该通道本为 L0（可全绕过）会话的调试/清理入口，对强制级别一律拒绝。
    if (active && isEnforcedLevel(active.level)) {
      throw new Error('强制会话中请使用紧急退出码（连按 5 次 Esc）解锁')
    }
    endEnforcement('manual')
    return true
  })

  // ---- 紧急退出 ----
  ipcMain.handle(
    IPC_CHANNELS.emergency.exit,
    async (_event, code: string): Promise<EmergencyExitResult> => {
      const level = active?.level ?? getSettings().lockLevel
      const result = await emergency.verifyRecoveryCode(
        str(code ?? '', 'emergency.code', { max: 100, allowEmpty: true }),
        level
      )
      if (result.ok) {
        endEnforcement('emergency')
      }
      return result
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.emergency.setCode,
    async (_event, code: string, password?: string): Promise<boolean> => {
      // CR-02：强制会话中禁止修改恢复码——否则"设新码 → 验证退出"两步即可绕过强制。
      if (active && isEnforcedLevel(active.level)) {
        throw new Error('强制会话中无法修改恢复码，请先结束当前会话')
      }
      const newCode = str(code ?? '', 'emergency.code', { max: 100 })
      const problem = emergency.validateRecoveryCode(newCode)
      if (problem) throw new Error(problem)
      // 已设置过恢复码时必须验证当前账户密码：防止渲染进程被攻破后直接覆盖恢复码
      // （绕过紧急退出的唯一凭据）。首次设置（无哈希）无需密码。
      if (emergency.hasRecoveryCode()) {
        const pwd =
          password === undefined
            ? ''
            : str(password, 'emergency.password', { max: 200, allowEmpty: true })
        const authResult = await verifyCurrentPassword(pwd)
        if (!authResult.ok) {
          const wait = authResult.retryInSec
            ? `（约 ${authResult.retryInSec} 秒后可再试）`
            : ''
          throw new Error(`${authResult.error}${wait}`)
        }
      }
      await emergency.setRecoveryCode(newCode)
      return true
    }
  )
  // P-2：紧急退出弹窗期间暂停窗口守卫的失焦拉回（渲染层随弹窗开合调用）
  ipcMain.handle(IPC_CHANNELS.emergency.setPullBackPaused, (_event, paused: boolean): void => {
    windowGuard.setPaused(bool(paused, 'emergency.paused'))
  })

  // ================= 视频学习强制会话句柄 =================

  function enterBiliSession(
    videoWin: BrowserWindow,
    opts: { plannedMs: number; topic: string }
  ): void {
    const cap = Math.min(opts.plannedMs || 0, getSettings().sessionMaxHours * 3600_000)
    beginEnforcement('bili', cap, videoWin)
    timer.start({ mode: 'countup', durationMs: cap })
  }

  function exitBiliSession(reason: 'manual' | 'completed' | 'emergency'): void {
    endEnforcement(reason)
  }

  return {
    restoreAfterRestart,
    enterBiliSession,
    exitBiliSession,
    setOverlayExempt: (win) => {
      overlayExemptWindow = win
    },
    setPullBackPaused: (paused) => {
      windowGuard.setPaused(paused)
    }
  }
}
