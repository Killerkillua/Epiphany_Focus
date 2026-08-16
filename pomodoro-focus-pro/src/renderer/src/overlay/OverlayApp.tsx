import { useEffect, useReducer, useRef } from 'react'
import { Button, Input, Tooltip, message } from 'antd'
import {
  CloseOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MinusOutlined,
  RobotOutlined,
  SendOutlined
} from '@ant-design/icons'
import type { AiMessage, BiliContext, NoteEntry, OverlaySnapshot, OverlayState } from '../../../shared/bili'

/**
 * 全屏悬浮面板（#overlay 路由，透明置顶窗口内运行）：
 * - 状态机 4 态：expanded / collapsed / minimized / hidden（主进程窗口状态为唯一事实源，
 *   overlayStateChanged 事件广播同步，避免主进程与渲染层状态撕裂）
 * - AI 学习助手（经 ai:ask 走主进程 AI 网关，B 站学习档位提示词 +
 *   学习上下文 topic/bvid + 最近多轮历史；未配 Key 时为演示回复）
 * - 记事本（500ms 防抖自动保存）
 * - 全局热键 Ctrl+Shift+O 呼出 / 隐藏（主进程注册）
 */

type Phase = OverlayState

interface OverlayUiState {
  phase: Phase
  canMinimize: boolean
  context: BiliContext | null
  notes: string
  aiInput: string
  aiLog: AiMessage[]
  asking: boolean
}

type Action =
  | { type: 'snapshot'; snapshot: OverlaySnapshot }
  | { type: 'set-context'; context: BiliContext | null }
  | { type: 'welcome'; message: string }
  | { type: 'set-notes'; notes: string }
  | { type: 'set-ai-input'; value: string }
  | { type: 'ask-start' }
  | { type: 'ask-done'; reply: AiMessage }
  | { type: 'ask-fail'; message: string }

const initialState: OverlayUiState = {
  phase: 'expanded',
  canMinimize: true,
  context: null,
  notes: '',
  aiInput: '',
  aiLog: [],
  asking: false
}

function reducer(state: OverlayUiState, action: Action): OverlayUiState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, phase: action.snapshot.state, canMinimize: action.snapshot.canMinimize }
    case 'set-context':
      return { ...state, context: action.context }
    case 'welcome':
      return { ...state, aiLog: [{ role: 'assistant', content: action.message }] }
    case 'set-notes':
      return { ...state, notes: action.notes }
    case 'set-ai-input':
      return { ...state, aiInput: action.value }
    case 'ask-start':
      return { ...state, asking: true }
    case 'ask-done':
      return { ...state, asking: false, aiLog: [...state.aiLog, action.reply] }
    case 'ask-fail':
      return {
        ...state,
        asking: false,
        aiLog: [...state.aiLog, { role: 'assistant', content: `AI 调用失败：${action.message}` }]
      }
  }
}

function OverlayApp(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  const logRef = useRef<HTMLDivElement>(null)

  // 初始化：同步主进程状态快照 + 订阅状态广播（热键 / 主进程自动折叠都会走到这里）
  useEffect(() => {
    void window.api.bili
      .overlayGetState()
      .then((snapshot) => dispatch({ type: 'snapshot', snapshot }))
      .catch((err) => console.error('[overlay] 获取状态失败:', err))
    const off = window.api.on<OverlaySnapshot>(window.api.events.bili.overlayStateChanged, (snapshot) => {
      dispatch({ type: 'snapshot', snapshot })
    })
    return off
  }, [])

  // 初始化：取学习上下文 + 载入已存笔记
  useEffect(() => {
    void window.api.bili.getContext().then((ctx) => {
      dispatch({ type: 'set-context', context: ctx })
      dispatch({
        type: 'welcome',
        message:
          `已进入 B 站学习模式${ctx?.topic ? `，主题「${ctx.topic}」` : ''}。\n` +
          '学习中有疑问随时提问：概念讲解、要点总结、随堂测验都可以。'
      })
    })
    void window.api.notes.load().then((entries: NoteEntry[]) => {
      dispatch({ type: 'set-notes', notes: entries.map((entry) => entry.content).join('\n\n') })
    })
  }, [])

  // 记事本：500ms 防抖自动保存（整份覆盖）
  useEffect(() => {
    if (!state.notes) return
    const timer = setTimeout(() => {
      void window.api.notes
        .save([{ id: 'main', createdAt: Date.now(), content: state.notes }])
        .catch((err) => {
          console.error('[overlay] 笔记保存失败:', err)
        })
    }, 500)
    return () => clearTimeout(timer)
  }, [state.notes])

  // AI 对话自动滚动到底部
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [state.aiLog])

  /* ===== 状态切换（主进程为事实源，快照回填 UI） ===== */
  const requestPhase = (next: Phase): void => {
    void window.api.bili
      .overlaySetState(next)
      .then((snapshot) => {
        dispatch({ type: 'snapshot', snapshot })
        if (snapshot.notice) message.warning(snapshot.notice)
      })
      .catch((err) => console.error('[overlay] 状态切换失败:', err))
  }

  const expand = (): void => requestPhase('expanded')
  const collapse = (): void => requestPhase('collapsed')
  const minimize = (): void => requestPhase('minimized')
  const hide = (): void => requestPhase('hidden')

  const askAi = async (): Promise<void> => {
    const text = state.aiInput.trim()
    if (!text || state.asking) return
    dispatch({ type: 'set-ai-input', value: '' })
    // 携带最近 8 轮对话（不含本轮提问），主进程注入 messages 保持多轮连贯
    const history = state.aiLog
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
      .slice(-8)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    dispatch({ type: 'ask-start' })
    try {
      const reply = await window.api.ai.ask({
        message: text,
        context: {
          topic: state.context?.topic ?? undefined,
          bvid: state.context?.bvid ?? undefined
        },
        history
      })
      dispatch({ type: 'ask-done', reply })
    } catch (err) {
      dispatch({ type: 'ask-fail', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const closeVideo = (): void => {
    void window.api.bili.closeVideo().catch((err) => console.error('[overlay] 关闭视频窗口失败:', err))
  }

  /* ===== 折叠态：侧边竖条 ===== */
  if (state.phase === 'collapsed') {
    return (
      <div className="overlay-tab">
        <Tooltip title="展开面板" placement="right">
          <Button type="text" className="overlay-tab-btn" icon={<MenuUnfoldOutlined />} onClick={expand} />
        </Tooltip>
        <div className="overlay-tab-label">学习助手</div>
        <Tooltip title="隐藏面板（Ctrl+Shift+O 呼出）" placement="right">
          <Button type="text" className="overlay-tab-btn" icon={<EyeInvisibleOutlined />} onClick={hide} />
        </Tooltip>
        <Tooltip title="关闭视频" placement="right">
          <Button type="text" className="overlay-tab-btn" icon={<CloseOutlined />} onClick={closeVideo} />
        </Tooltip>
      </div>
    )
  }

  // minimized / hidden：窗口本身不可见，无需渲染内容
  if (state.phase !== 'expanded') {
    return <div className="overlay-root overlay-invisible" />
  }

  /* ===== 展开态：AI 助手 + 记事本 ===== */
  return (
    <div className="overlay-root">
      <div className="overlay-header">
        <span className="overlay-title">
          <RobotOutlined /> 学习助手
          {state.context?.bvid && <span className="overlay-bvid">{state.context.bvid}</span>}
        </span>
        <div className="overlay-header-actions">
          <Tooltip title={state.canMinimize ? '最小化' : '当前锁定等级不支持最小化'}>
            <Button
              type="text"
              size="small"
              icon={<MinusOutlined />}
              disabled={!state.canMinimize}
              onClick={minimize}
            />
          </Tooltip>
          <Tooltip title="隐藏面板（Ctrl+Shift+O 呼出）">
            <Button type="text" size="small" icon={<EyeInvisibleOutlined />} onClick={hide} />
          </Tooltip>
          <Tooltip title="折叠面板">
            <Button type="text" size="small" icon={<MenuFoldOutlined />} onClick={collapse} />
          </Tooltip>
          <Tooltip title="关闭视频">
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={closeVideo} />
          </Tooltip>
        </div>
      </div>

      <div className="overlay-body">
        {/* AI 助手 */}
        <div className="overlay-section overlay-ai">
          <div className="overlay-section-title">AI 助手</div>
          <div className="overlay-ai-log" ref={logRef}>
            {state.aiLog.map((msg, index) => (
              <div key={index} className={`overlay-msg ${msg.role === 'user' ? 'user' : 'assistant'}`}>
                {msg.content}
              </div>
            ))}
            {state.asking && <div className="overlay-msg assistant overlay-typing">思考中…</div>}
          </div>
          <div className="overlay-ai-input">
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 3 }}
              placeholder="向 AI 提问，如：讲解这个概念 / 总结要点 / 出几道测验题"
              value={state.aiInput}
              onChange={(e) => dispatch({ type: 'set-ai-input', value: e.target.value })}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void askAi()
                }
              }}
            />
            <Button
              type="primary"
              size="small"
              icon={<SendOutlined />}
              loading={state.asking}
              disabled={!state.aiInput.trim()}
              onClick={() => void askAi()}
            />
          </div>
        </div>

        {/* 记事本 */}
        <div className="overlay-section overlay-notes">
          <div className="overlay-section-title">
            <EditOutlined /> 记事本 <span className="overlay-autosave">500ms 自动保存</span>
          </div>
          <Input.TextArea
            className="overlay-notes-input"
            value={state.notes}
            onChange={(e) => dispatch({ type: 'set-notes', notes: e.target.value })}
            placeholder="随时记录要点 / 疑问 / 灵感…"
          />
        </div>
      </div>
    </div>
  )
}

export default OverlayApp
