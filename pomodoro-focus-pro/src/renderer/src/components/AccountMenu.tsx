import type { AuthState } from '../../../shared/auth'

interface AccountMenuProps {
  auth: AuthState
  /** 当前是否处于账户设置页（高亮） */
  active?: boolean
  onOpenSettings: () => void
}

/** 侧边栏最下端的账号入口：头像（昵称首字）+ 昵称；点击直接进入「账户设置」 */
export default function AccountMenu({
  auth,
  active,
  onOpenSettings
}: AccountMenuProps): JSX.Element | null {
  if (auth.status === 'loggedOut') return null
  const isGuest = auth.status === 'guest'
  const name = isGuest ? '游客' : auth.user.nickname
  const initial = (name.trim()[0] ?? '?').toUpperCase()

  return (
    <div
      className={`app-account${active ? ' app-account-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpenSettings}
      title="点击打开账户设置"
    >
      <span className="app-account-avatar">{initial}</span>
      <span className="app-account-info">
        <span className="app-account-name">{name}</span>
        <span className="app-account-sub">账户设置</span>
      </span>
    </div>
  )
}
