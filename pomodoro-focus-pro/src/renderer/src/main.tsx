import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles/global.css'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

root.render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          // 深色主题 + 强调色 #ff6b4a（番茄红橙）
          colorPrimary: '#ff6b4a',
          colorBgBase: '#0f1115',
          colorBgContainer: '#171b22',
          colorBgElevated: '#1e242e',
          colorBorder: '#2a313c',
          colorTextBase: '#e8eaed',
          colorTextSecondary: '#9aa3af',
          borderRadius: 8,
          fontFamily:
            "'WorkSans', 'Noto Sans CJK SC', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          // 阶段三：antd 内置断点与项目内容驱动断点对齐（md=768 / xl=1200 / xxl=1600，
          // Grid Row/Col 与 Layout.Sider 的 breakpoint 均读取这些 token）
          screenXS: 480,
          screenSM: 576,
          screenMD: 768,
          screenLG: 992,
          screenXL: 1200,
          screenXXL: 1600
        },
        components: {
          Layout: {
            // 与 .app-sider 的 --bg2 背景一致（含折叠触发器），避免组件与全局样式色差
            siderBg: '#171b22',
            triggerBg: '#171b22'
          }
        }
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
