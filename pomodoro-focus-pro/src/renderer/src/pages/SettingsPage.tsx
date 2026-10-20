import { useSettingsLoader } from './settings/useSettingsLoader'
import EnforcementCard from './settings/EnforcementCard'
import PomodoroCard from './settings/PomodoroCard'
import BiliCard from './settings/BiliCard'
import StudySessionCard from './settings/StudySessionCard'
import AiSettingsCard from './settings/AiSettingsCard'
import NoiseCard from './settings/NoiseCard'
import DataManagementCard from './settings/DataManagementCard'
import HelpImproveCard from './settings/HelpImproveCard'

/**
 * 设置页（方案 4.2）：合并全部配置，写 electron-store，即时生效。
 * 本文件仅做编排：加载设置（useSettingsLoader）→ 渲染各分组卡片。
 * 各分组表单逻辑与弹窗已拆至 settings/ 目录（问题 H-10）。
 */

function SettingsPage(): JSX.Element {
  const { form, setForm, saving, backups, load, refreshBackups, update } = useSettingsLoader()

  return (
    <div>
      <h1 className="page-title">设置</h1>
      <p className="page-sub">全部配置即时生效（electron-store 持久化）</p>

      <div className="settings-layout">
        <EnforcementCard form={form} saving={saving} update={update} onCodeSaved={load} />
        <PomodoroCard form={form} saving={saving} update={update} />
        <BiliCard form={form} saving={saving} update={update} />
        <StudySessionCard form={form} saving={saving} update={update} />
        <AiSettingsCard
          form={form}
          setForm={setForm}
          saving={saving}
          update={update}
          reload={load}
        />
        <NoiseCard form={form} saving={saving} update={update} />
        <DataManagementCard
          form={form}
          setForm={setForm}
          saving={saving}
          update={update}
          backups={backups}
          refreshBackups={refreshBackups}
        />
        <HelpImproveCard form={form} saving={saving} update={update} />
      </div>
    </div>
  )
}

export default SettingsPage
