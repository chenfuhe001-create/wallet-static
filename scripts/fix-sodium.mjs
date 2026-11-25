// libsodium-wrappers-sumo 0.7.16 的 ESM 入口会 import './libsodium-sumo.mjs'，
// 但该文件在独立的 libsodium-sumo 包里。安装后复制一次，保证浏览器/CI 构建一致。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const base = path.resolve(root, '..', 'node_modules')
const src = path.join(base, 'libsodium-sumo', 'dist', 'modules-sumo-esm', 'libsodium-sumo.mjs')
const dstDir = path.join(base, 'libsodium-wrappers-sumo', 'dist', 'modules-sumo-esm')
const dst = path.join(dstDir, 'libsodium-sumo.mjs')

if (fs.existsSync(dst)) process.exit(0)
if (!fs.existsSync(src)) {
  console.error('[fix-sodium] 找不到 libsodium-sumo，请先 npm install')
  process.exit(1)
}
fs.mkdirSync(dstDir, { recursive: true })
fs.copyFileSync(src, dst)
console.log('[fix-sodium] 已补齐 libsodium-sumo.mjs')
