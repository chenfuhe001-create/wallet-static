import { useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { BSC, OP } from './chains'
import {
  addWallet,
  closeVault,
  createVault,
  exportVaultJson,
  parseVaultJson,
  unlockVault,
} from './crypto/vault'
import type { EncryptedVault, OpenedVault } from './crypto/vault'
import { clearStoredVault, loadStoredVault, saveStoredVault } from './storage'
import { estimateBnbTransfer, getBscBalance, sendBnb } from './evm/bsc'
import { getOpOverview, sendOpUsdc } from './evm/op'
import type { OpOverview } from './evm/op'

type View = 'locked' | 'unlock' | 'create'

interface TransferState {
  to: string
  amount: string
  gasPrice: string
  busy: boolean
  error: string
  result: string
}

const EMPTY_TRANSFER: TransferState = { to: '', amount: '', gasPrice: '', busy: false, error: '', result: '' }

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [view, setView] = useState<View>('locked')
  const [stored, setStored] = useState<EncryptedVault | null>(null)
  const [opened, setOpened] = useState<OpenedVault | null>(null)
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [balances, setBalances] = useState<Record<string, string>>({})
  const [chain, setChain] = useState<'bsc' | 'op'>('bsc')
  const [opBalances, setOpBalances] = useState<Record<string, OpOverview>>({})
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [transfer, setTransfer] = useState<TransferState>(EMPTY_TRANSFER)
  const [reveal, setReveal] = useState<{ address: string; privateKey: Hex } | null>(null)
  const [importKey, setImportKey] = useState('')
  const revealTimer = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void (async () => {
      try {
        const data = await loadStoredVault()
        setStored(data)
        setView(data ? 'unlock' : 'create')
      } catch (e) {
        setError(e instanceof Error ? e.message : '读取本地保险箱失败')
      }
    })()
    return () => {
      if (revealTimer.current) window.clearTimeout(revealTimer.current)
    }
  }, [])

  const activeWallets = useMemo(
    () => (opened ? opened.wallets.filter((w) => w.status !== 'deleted') : []),
    [opened],
  )
  const selected = activeWallets.find((w) => w.id === selectedId) || activeWallets[0] || null

  const resetSecretState = () => {
    setPassword('')
    setPassword2('')
    setReveal(null)
    setTransfer(EMPTY_TRANSFER)
    if (revealTimer.current) window.clearTimeout(revealTimer.current)
  }

  const lock = () => {
    if (opened) closeVault(opened)
    setOpened(null)
    resetSecretState()
    setView(stored ? 'unlock' : 'create')
    setNotice('已锁定，内存中的私钥已清除')
  }

  const unlock = async () => {
    if (!stored) return
    setBusy('正在用 Argon2id 解锁…')
    setError('')
    try {
      const next = await unlockVault(stored, password)
      setOpened(next)
      setPassword('')
      setView('locked')
      setNotice('已解锁；密码与私钥只在当前页面内存中')
      void refreshBalances(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '解锁失败')
    } finally {
      setBusy('')
    }
  }

  const create = async () => {
    if (password !== password2) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy('正在生成保险箱（Argon2id 256MiB，手机可能需要几秒）…')
    setError('')
    try {
      const next = await createVault({
        password,
        privateKeys: [generatePrivateKey()],
        label: label.trim(),
      })
      await saveStoredVault(next.data)
      setStored(next.data)
      setOpened(next)
      setPassword('')
      setPassword2('')
      setView('locked')
      setNotice('新保险箱已创建并保存在本浏览器；请立即导出加密备份')
      void refreshBalances(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    } finally {
      setBusy('')
    }
  }

  const importFile = async (file: File) => {
    setError('')
    try {
      const text = await file.text()
      const data = parseVaultJson(text)
      await saveStoredVault(data)
      setStored(data)
      setView('unlock')
      setNotice('保险箱已导入本地；输入原密码解锁')
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    }
  }

  const refreshBalances = async (vault: OpenedVault | null = opened) => {
    if (!vault) return
    const active = vault.wallets.filter((w) => w.status !== 'deleted')
    if (chain === 'bsc') {
      const next: Record<string, string> = {}
      await Promise.all(
        active.map(async (w) => {
          try {
            const b = await getBscBalance(w.address)
            next[w.address] = b.bnb
          } catch {
            next[w.address] = '读取失败'
          }
        }),
      )
      setBalances((old) => ({ ...old, ...next }))
      return
    }
    const next: Record<string, OpOverview> = {}
    await Promise.all(
      active.map(async (w) => {
        try {
          next[w.address] = await getOpOverview(w.address)
        } catch {
          /* 单地址失败不影响其他 */
        }
      }),
    )
    setOpBalances((old) => ({ ...old, ...next }))
  }

  useEffect(() => {
    if (opened) void refreshBalances(opened)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain])

  const persist = async (vault: OpenedVault) => {
    await saveStoredVault(vault.data)
    setStored(vault.data)
  }

  const addNew = async () => {
    if (!opened) return
    setBusy('正在生成钱包…')
    setError('')
    try {
      const wallet = await addWallet(opened, generatePrivateKey(), label.trim())
      await persist(opened)
      setSelectedId(wallet.id)
      setNotice(`已生成钱包 #${wallet.id}`)
      void refreshBalances()
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy('')
    }
  }

  const addImported = async () => {
    if (!opened) return
    const raw = importKey.trim()
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw) && !/^[0-9a-fA-F]{64}$/.test(raw)) {
      setError('私钥格式应为 64 位十六进制（可带 0x）')
      return
    }
    const key = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
    setBusy('正在导入…')
    setError('')
    try {
      const wallet = await addWallet(opened, key, label.trim())
      await persist(opened)
      setImportKey('')
      setSelectedId(wallet.id)
      setNotice(`已导入钱包 #${wallet.id}`)
      void refreshBalances()
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败')
    } finally {
      setBusy('')
    }
  }

  const revealKey = (wallet: (typeof activeWallets)[number]) => {
    setReveal({ address: wallet.address, privateKey: wallet.privateKey })
    if (revealTimer.current) window.clearTimeout(revealTimer.current)
    revealTimer.current = window.setTimeout(() => setReveal(null), 60_000)
  }

  const estimate = async () => {
    if (!selected) return
    setTransfer((s) => ({ ...s, busy: true, error: '', result: '' }))
    try {
      const est = await estimateBnbTransfer({
        from: selected.address,
        to: transfer.to,
        amountBnb: transfer.amount,
        gasPriceGwei: transfer.gasPrice,
      })
      setTransfer((s) => ({
        ...s,
        busy: false,
        result: `预估 gas ${est.gasLimit} × ${est.gasPrice} wei ≈ ${est.feeBnb} BNB`,
      }))
    } catch (e) {
      setTransfer((s) => ({ ...s, busy: false, error: e instanceof Error ? e.message : '预估失败' }))
    }
  }

  const send = async () => {
    if (!selected) return
    if (!window.confirm(`确认从 ${selected.address} 转出 ${transfer.amount} BNB 到 ${transfer.to}？\n\n交易将在本地签名后直接广播，不可撤销。`)) {
      return
    }
    setTransfer((s) => ({ ...s, busy: true, error: '', result: '' }))
    try {
      const res = await sendBnb({
        privateKey: selected.privateKey,
        to: transfer.to,
        amountBnb: transfer.amount,
        gasPriceGwei: transfer.gasPrice,
      })
      setTransfer((s) => ({
        ...s,
        busy: false,
        result: `已广播：${res.hash}\n手续费：${res.feeBnb} BNB`,
      }))
      setNotice('交易已广播；请用区块浏览器核对')
      void refreshBalances()
    } catch (e) {
      setTransfer((s) => ({
        ...s,
        busy: false,
        error: e instanceof Error ? e.message : '发送失败',
      }))
    }
  }

  const sendOp = async () => {
    if (!selected) return
    if (
      !window.confirm(
        `确认从 ${selected.address} 转出 ${transfer.amount} USDC（OP）到 ${transfer.to}？\n\n` +
          '首次使用会自动做 EIP-7702 激活；gas 用 USDC 支付，手续费上限 0.05（首次 0.10）USDC。\n交易在本地签名，不可撤销。',
      )
    ) {
      return
    }
    setTransfer((s) => ({ ...s, busy: true, error: '', result: '' }))
    try {
      const res = await sendOpUsdc({
        privateKey: selected.privateKey,
        to: transfer.to,
        amountUsdc: transfer.amount,
      })
      setTransfer((s) => ({
        ...s,
        busy: false,
        result: [
          `UserOp：${res.userOpHash}`,
          res.txHash ? `交易：${res.txHash}` : '',
          res.feeUsdc ? `手续费：${res.feeUsdc} USDC` : '',
          `状态：${res.status}`,
          res.explorer,
        ]
          .filter(Boolean)
          .join('\n'),
      }))
      setNotice('UserOp 已提交；请用区块浏览器核对')
      void refreshBalances()
    } catch (e) {
      setTransfer((s) => ({ ...s, busy: false, error: e instanceof Error ? e.message : '提交失败' }))
    }
  }

  if (!opened) {
    return (
      <div className="app">
        <header className="hero">
          <div>
            <h1>本地钱包</h1>
            <p className="muted">密码、私钥、签名只在本浏览器；服务器不参与。</p>
          </div>
          <span className="badge">离线签名</span>
        </header>

        <div className="warn">
          ⚠️ 这是本地钱包：没有服务器找回密码。请导出加密备份并离线保存；忘记密码 = 永久丢失。
        </div>

        <section className="card">
          {view === 'unlock' && stored ? (
            <>
              <h2>解锁已有保险箱</h2>
              <p className="muted">本浏览器已保存一份密文。输入原密码；密码只在内存。</p>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="钱包密码（至少 12 位）"
                autoComplete="current-password"
              />
              <button className="primary" onClick={() => void unlock()} disabled={Boolean(busy)}>
                {busy || '解锁'}
              </button>
              <div className="row">
                <button className="ghost" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
                  导入另一个保险箱文件
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    if (!window.confirm('清除本浏览器保存的密文？已导出的备份不会被删除。')) return
                    void clearStoredVault().then(() => {
                      setStored(null)
                      setView('create')
                    })
                  }}
                  disabled={Boolean(busy)}
                >
                  清除本机密文
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>创建本地保险箱</h2>
              <p className="muted">会生成一个新的随机私钥；也可以创建后导入旧钱包。</p>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="设置钱包密码（至少 12 位）"
                autoComplete="new-password"
              />
              <input
                type="password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
              />
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="标签（可选）" />
              <button className="primary" onClick={() => void create()} disabled={Boolean(busy)}>
                {busy || '创建保险箱'}
              </button>
              <button className="ghost" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
                导入已有保险箱（wallets.json）
              </button>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importFile(f)
              e.target.value = ''
            }}
          />
          {busy ? <p className="muted">{busy}</p> : null}
          {error ? <div className="error">{error}</div> : null}
          {notice ? <div className="notice">{notice}</div> : null}
        </section>

        <footer className="muted small">
          静态页面 · 无后端 · 直连公共 RPC · 密码/私钥不离开本机
        </footer>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <h1>本地钱包</h1>
          <p className="muted">
            {activeWallets.length} 个钱包 · {chain === 'bsc' ? 'BSC' : 'OP'} · 已解锁
          </p>
        </div>
        <div className="row">
          <button className="ghost" onClick={() => void refreshBalances()} disabled={Boolean(busy)}>
            刷新余额
          </button>
          <button className="danger" onClick={lock}>
            锁定
          </button>
        </div>
      </header>

      <div className="row chainTabs">
        <button className={chain === 'bsc' ? 'primary' : 'ghost'} onClick={() => setChain('bsc')}>
          BSC · BNB
        </button>
        <button className={chain === 'op' ? 'primary' : 'ghost'} onClick={() => setChain('op')}>
          OP · USDC（AA）
        </button>
        <span className="small muted">切换只影响查询/转账，不改钱包</span>
      </div>

      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <section className="card">
        <div className="row space">
          <h2>钱包列表</h2>
          <div className="row">
            <button className="ghost" onClick={() => void addNew()} disabled={Boolean(busy)}>
              生成新钱包
            </button>
            <button
              className="ghost"
              onClick={() => downloadText(`wallet-backup-${Date.now()}.json`, exportVaultJson(opened.data))}
            >
              导出加密备份
            </button>
          </div>
        </div>

        <div className="list">
          {activeWallets.map((w) => (
            <button
              key={w.id}
              className={`walletRow ${selected?.id === w.id ? 'active' : ''}`}
              onClick={() => setSelectedId(w.id)}
            >
              <div>
                <div className="walletTitle">
                  #{w.id} {w.label || '未命名'}
                </div>
                <div className="mono small">{w.address}</div>
              </div>
              <div className="right">
                <div className="mono">
                  {chain === 'bsc'
                    ? `${balances[w.address] ?? '—'} BNB`
                    : `${opBalances[w.address]?.usdc ?? '—'} USDC`}
                </div>
                <div className="small muted">
                  {chain === 'op'
                    ? opBalances[w.address]?.delegation.status === 'delegated'
                      ? '7702 已激活'
                      : opBalances[w.address]?.delegation.status ?? short(w.address)
                    : short(w.address)}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="row importRow">
          <input
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
            placeholder="导入私钥（64 位 hex，可带 0x）"
            spellCheck={false}
          />
          <button className="ghost" onClick={() => void addImported()} disabled={Boolean(busy)}>
            导入
          </button>
        </div>
      </section>

      {selected ? (
        <>
          {chain === 'bsc' ? (
          <section className="card">
            <div className="row space">
              <h2>转账 · BSC（BNB）</h2>
              <span className="small muted">#{selected.id} {short(selected.address)}</span>
            </div>
            <input
              value={transfer.to}
              onChange={(e) => setTransfer((s) => ({ ...s, to: e.target.value }))}
              placeholder="收款地址 0x…"
              spellCheck={false}
            />
            <div className="row">
              <input
                value={transfer.amount}
                onChange={(e) => setTransfer((s) => ({ ...s, amount: e.target.value }))}
                placeholder="金额（BNB）"
                inputMode="decimal"
              />
              <input
                value={transfer.gasPrice}
                onChange={(e) => setTransfer((s) => ({ ...s, gasPrice: e.target.value }))}
                placeholder="gasPrice Gwei（留空自动）"
                inputMode="decimal"
              />
            </div>
            <div className="row">
              <button className="ghost" onClick={() => void estimate()} disabled={transfer.busy}>
                预估手续费
              </button>
              <button className="primary" onClick={() => void send()} disabled={transfer.busy}>
                {transfer.busy ? '处理中…' : '本地签名并广播'}
              </button>
            </div>
            {transfer.result ? <pre className="result">{transfer.result}</pre> : null}
            {transfer.error ? <div className="error">{transfer.error}</div> : null}
            <p className="small muted">
              私钥只在点击按钮后用于本地签名；广播请求只包含已签名交易，不含私钥。
            </p>
          </section>
          ) : (
          <section className="card">
            <div className="row space">
              <h2>转账 · OP（USDC，gas 用 USDC）</h2>
              <span className="small muted">#{selected.id} {short(selected.address)}</span>
            </div>
            <p className="small muted">
              USDC 余额：{opBalances[selected.address]?.usdc ?? '—'} · 7702：
              {opBalances[selected.address]?.delegation.status === 'delegated'
                ? '已激活'
                : opBalances[selected.address]?.delegation.status ?? '未知'}
            </p>
            <input
              value={transfer.to}
              onChange={(e) => setTransfer((s) => ({ ...s, to: e.target.value }))}
              placeholder="收款地址 0x…"
              spellCheck={false}
            />
            <input
              value={transfer.amount}
              onChange={(e) => setTransfer((s) => ({ ...s, amount: e.target.value }))}
              placeholder="金额（USDC）"
              inputMode="decimal"
            />
            <div className="row">
              <button className="primary" onClick={() => void sendOp()} disabled={transfer.busy}>
                {transfer.busy ? '签名/提交中…' : '本地签名并提交 UserOp'}
              </button>
            </div>
            {transfer.result ? <pre className="result">{transfer.result}</pre> : null}
            {transfer.error ? <div className="error">{transfer.error}</div> : null}
            <p className="small muted">
              首次自动 7702 激活；permit/UserOp/授权全部本地签名，bundler 只收到已签名 UserOp。
              建议先用 0.01 USDC 验证。
            </p>
          </section>
          )}

          <section className="card">
            <div className="row space">
              <h2>私钥二维码</h2>
              <button className="ghost" onClick={() => revealKey(selected)}>
                显示 60 秒
              </button>
            </div>
            {reveal ? (
              <>
                <div className="qrWrap">
                  <QRCodeSVG value={reveal.privateKey} size={220} level="M" includeMargin />
                </div>
                <p className="small muted">地址 {reveal.address}</p>
                <p className="small muted">二维码只在本页内存；60 秒后自动清除，不落盘、不复制。</p>
                <button className="danger" onClick={() => setReveal(null)}>
                  立即清除
                </button>
              </>
            ) : (
              <p className="muted">私钥不显示文本，只按需生成本地二维码。</p>
            )}
          </section>
        </>
      ) : null}

      <footer className="muted small">
        本地签名 · 直连 BSC RPC · 服务器不接触密码/私钥。大额建议使用硬件钱包或多签。
      </footer>
    </div>
  )
}
