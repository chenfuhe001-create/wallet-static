import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 子路径部署：base 用相对路径，资源才能从 /wallet-static/ 正常加载
export default defineConfig({
  base: './',
  plugins: [react()],
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
