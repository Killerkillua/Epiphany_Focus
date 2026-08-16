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
            "'WorkSans', 'Noto Sans CJK SC', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        }
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
