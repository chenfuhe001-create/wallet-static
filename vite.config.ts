import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 子路径部署：base 用相对路径，资源才能从 /wallet-static/ 正常加载
export default defineConfig({
  base: './',
  plugins: [react()],
  // libsodium 的 ESM 入口含 top-level await；dev 预构建也要用 es2022，否则 vite 启动即失败。
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          viem: ['viem'],
          sodium: ['libsodium-wrappers-sumo'],
        },
      },
    },
  },
})
