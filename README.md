# wallet-static

完全本地的静态钱包：**密码、私钥、签名只在本浏览器**；服务器不参与密钥、不参与签名、不参与广播。

- 前端：Vite + React + TypeScript
- 加密：libsodium（Argon2id + XChaCha20-Poly1305 + HKDF-SHA256），格式与 web 项目 `wallet_core.py` 兼容
- 链交互：viem + 浏览器直连公共 RPC（BSC 原生 BNB；OP Circle v0.8 AA / 7702 / USDC gas）
- 托管：GitHub Pages（`docs/`），与 API 服务器分离

## 安全模型

- 钱包密码只在浏览器内存中使用，用来解开本地加密保险箱。
- 私钥解密后只用于本地签名；广播请求只包含已签名交易。
- 加密保险箱存 IndexedDB，可导出 `.json` 备份；密码/私钥不写 localStorage、不打日志。
- 页面使用严格 CSP，不加载第三方脚本/CDN。
- 大额资金仍建议硬件钱包或多签；浏览器扩展、XSS、设备丢失仍是残余风险。

## 本地开发

```bash
npm install
npm run dev
npm test
npm run build
```

## 从现有服务器钱包迁移

1. 在旧钱包页面导出加密保险箱（`wallets-日期.json`，仍是密文）。
2. 打开本页 →「导入已有保险箱」→ 输入原钱包密码。
3. 核对地址/余额；先转 0.001 BNB 验证。
4. 导出新的加密备份，离线保存；确认稳定后再停旧服务器钱包接口。

> 当前服务器仍保持原样，未迁移、未停用；等本地验证稳定后再切换。

## 部署

`npm run build` 后把 `dist/` 复制到 `docs/`，提交到 `main`；GitHub Pages 设置为 `main` / `docs`。
发布后建议在 release 里记录 `index.html` 的 SHA-256，便于核对版本。

## 状态

- [x] 兼容导入服务器 `wallets.json`
- [x] 本地生成/导入/加密备份
- [x] BSC BNB 本地签名 + 直连 RPC 广播
- [x] 私钥本地二维码
- [x] OP / Circle v0.8 AA（USDC permit、7702 授权、paymasterData、Pimlico 直连）
- [x] 本地改密 / 重新加密备份
- [x] 真实链上 canary（用户确认 BSC/OP 小额转账成功）
- [ ] 本地地址本 / 批量转账

## 开发约定与技能

- `.openhands/skills/` 已从 web 项目迁移通用技能：`memory`、`skill-guide`、`writing-great-skills`、`grill-me`、`to-spec`、`to-tickets`、`tdd`、`code-review`。
- 任务前按 `memory` 技能检索 `Ai记忆库/索引.json`；非微小改动后落盘记忆并推送。
- 测试/临时脚本必须清理，不留在仓库；`docs/` 是 Pages 产物，`dist/`、`node_modules/`、`*.tsbuildinfo` 不入库。
- 本项目专属决策记录见 `Ai记忆库/决策记录/`；当前 ADR_001：本地签名 + 服务器钱包暂不退役。
