import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // 主进程依赖（electron 等）保持外部引用，不打包
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 主进程、守护进程，以及备份 Worker（不占用 UI 线程）
        input: {
          index: resolve('src/main/index.ts'),
          guardian: resolve('src/main/guardian/guardian.ts'),
          backupWorker: resolve('src/main/storage/backupWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
