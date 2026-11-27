# wallet-static

完全本地的静态钱包：**密码、私钥、签名只在本浏览器**；服务器不参与密钥、不参与签名、不参与广播。

- 前端：Vite + React + TypeScript
- 加密：libsodium（Argon2id + XChaCha20-Poly1305 + HKDF-SHA256），格式与 web 项目 `wallet_core.py` 兼容
- 链交互：viem + 浏览器直连公共 RPC（BSC 原生 BNB；7 条链 Circle v0.8 AA / 7702 / USDC gas）
- 多链注册表：`src/chains.ts`；转账资产 USDC/USDT0/USDT 只从注册表取，前端不能传任意合约地址
- 托管：GitHub Pages（`docs/`），与 API 服务器分离

## 安全模型

- 钱包密码只在浏览器内存中使用，用来解开本地加密保险箱。
- 私钥解密后只用于本地签名；广播请求只包含已签名交易。
- 加密保险箱存 IndexedDB，可导出 `.json` 备份；密码/私钥不写 localStorage、不打日志。
- 页面使用严格 CSP，不加载第三方脚本/CDN。
- 大额资金仍建议硬件钱包或多签；浏览器扩展、XSS、设备丢失仍是残余风险。

## 界面与默认链

- 默认链是 **Ethereum（USDC AA）**；切换链会写入本机 `localStorage`，下次打开沿用；点「默认 ETH AA」可恢复。
- 顶部不再放 USDC/USDT/USDT0 切换标签；钱包列表直接显示全部代币与原生币余额。
- 转账区的「转账资产」下拉统一选择代币或原生币；原生币符号按链取（ETH / BNB / POL / AVAX），AA 链也支持原生币转账（gas 仍用 USDC）。
- 批量「一个钱包 → 多个地址」支持从本地钱包勾选收款地址，勾选结果与手动输入合并、自动去重。

## 地址簿（本地 EVM）

- 地址簿与钱包保险箱**完全独立**：独立密码、独立密文文件、独立 IndexedDB（`wallet-static-address-book`）。
- 加密/导出格式与 web 项目 `wallet_book.py` 一致：Argon2id13 + XChaCha20-Poly1305，`meta.scheme=wallet-address-book-v1`，记录 HKDF info `oe44-wallet-address-book-v1`；文件里没有明文地址。
- 支持创建、搜索、添加、编辑、删除、导出密文、导入密文；导入覆盖非空地址簿前会本地备份旧密文。
- web 导出的地址簿可直接导入本地；本地导出的 EVM 地址簿可被 web 导入。
- 地址簿只存 EVM 地址；比特币转账请手动填写 BTC 地址（格式兼容优先）。
- 密码丢失只能靠导出的密文 + 密码恢复，没有找回入口。

## 原生比特币（主网）

- 支持单笔主网 P2WPKH 普通转账；不做批量、测试网、RBF/CPFP、coin control。
- 每个现有钱包用同一把 secp256k1 私钥派生一个 `bc1q…` 地址；不改保险箱格式，但同一密钥同时控制 EVM/BTC，存在关联与单点风险。
- UTXO/费率/广播走 Blockstream Esplora，mempool.space 备用；CSP 已放行两个域名。
- 广播前本地选 UTXO、算 vsize/粉尘找零、本地签名；广播响应丢失时按 txid 核对，重播同一份 raw tx，绝不重新选 UTXO 构造第二笔。
- 默认链仍是以太坊 AA；切换链会记住，Bitcoin 也可以设为默认。

## 网络失败与重试

- **广播前失败**（读 RPC、估算 gas、签名）：交易肯定没发出，批量里标「失败」且可重试。
- **广播调用失败**（`eth_sendRawTransaction` / `eth_sendUserOperation` 抛错）：先查链上 nonce/回执；只有确认 nonce 未变且错误是验证阶段拒绝，才标「失败」可重试。网络错误、`AA25`、`already known` 等一律标「结果不明」并停止该钱包后续笔，避免双花。
- **公共 Pimlico 限流**：官方 20 次/分钟/IP，实测更容易触发 WAF。bundler 请求现在走全局滑动窗口（默认 5 次/分钟、最小间隔 10 秒）；遇到 HTTP 429 / `Failed to fetch` 全局冷却 60 秒并降速，冷却期不再轮询。回执等待改用普通 RPC 的 EntryPoint nonce，打包后只查一次回执；批量核对用 JSON-RPC 批量。9 笔约 3–4 分钟，期间不要关闭页面或开多个标签。
- **结果不明项核对**：优先批量查 UserOp 回执；没有 UserOp 哈希的旧记录按 USDC `Transfer` 日志的 from/to/金额精确匹配，找到即成功，找不到才可重试。
- 页面底部显示构建时间（UTC），用于确认 GitHub Pages 是否已更新；Pages 有缓存，必要时强制刷新。

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
- [x] 多链扩展（Base/Arbitrum/Ethereum/Polygon/Avalanche/Unichain）：注册表 + 7 链只读核验
- [x] 以太坊普通转账（原生 ETH legacy；与 USDC AA 入口并存，按 key 选择）
- [x] 多资产转账（USDC / USDT0 / USDT；gas 固定 USDC）
- [ ] 新链真实 canary（Base/Arbitrum/Polygon 各 0.01 USDC，待用户批准）
- [x] 批量转账（一个→多个地址、多个→一个地址；逐笔签名、非原子、结果恢复）
- [x] bundler 动态限速/冷却、gas 估算复用、nonce 等待回执、批量回执核对
- [x] 默认链本地记忆（默认 Ethereum AA）、多资产余额合并显示、批量勾选本地收款地址
- [x] 转账区资产下拉；各链原生币（ETH/BNB/POL/AVAX）AA 转账支持
- [x] 本地 EVM 地址簿（与 web 密文格式互导）+ 转账选择
- [x] 原生比特币主网 P2WPKH 单笔转账（Blockstream/mempool.space）
- [ ] 批量真实 canary（BSC 0.001 BNB ×3 / OP 0.01 USDC ×2，待用户批准）
- [x] 本地指纹（WebAuthn PRF）：PRF → HKDF → AES-GCM 包装密码，改密/导入/清除后失效
- [ ] 本地地址本（未列入本期）

## 开发约定与技能

- 多链 / 批量 / 指纹均已实现；剩余真实链 canary 见上方状态。长期结论在 `Ai记忆库`、`ADR_002`、`ADR_003`。
- 链选择按 `ChainConfig.key`（不是 chainId）：以太坊同时有 `ethereum-native`（普通 ETH）与 `ethereum`（USDC AA）两个入口。
- `.openhands/skills/` 已从 web 项目迁移通用技能：`memory`、`skill-guide`、`writing-great-skills`、`grill-me`、`to-spec`、`to-tickets`、`tdd`、`code-review`。
- 任务前按 `memory` 技能检索 `Ai记忆库/索引.json`；非微小改动后落盘记忆并推送。
- 测试/临时脚本必须清理，不留在仓库；`docs/` 是 Pages 产物，`dist/`、`node_modules/`、`*.tsbuildinfo` 不入库。
- 本项目专属决策记录见 `Ai记忆库/决策记录/`；当前 ADR_001：本地签名 + 服务器钱包暂不退役。
