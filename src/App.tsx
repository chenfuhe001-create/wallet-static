import { useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { BSC, CHAINS, feeCapFor, getChain, isAaChain } from './chains'
import type { AaChainConfig } from './chains'
import {
  addWallet,
  changePassword,
  closeVault,
  createVault,
  exportVaultJson,
  parseVaultJson,
  unlockVault,
} from './crypto/vault'
import type { EncryptedVault, OpenedVault } from './crypto/vault'
import { clearStoredVault, loadStoredVault, saveStoredVault } from './storage'
import { DEFAULT_CHAIN_KEY, loadDefaultChainKey, saveDefaultChainKey } from './preferences'
import {
  clearFingerprint,
  enableFingerprint,
  hasFingerprint,
  isWebAuthnSupported,
  unlockWithFingerprint,
} from './crypto/fingerprint'
import { estimateNativeTransfer, getNativeBalance, sendNative } from './evm/native'
import BatchPanel from './BatchPanel'
import { getAaOverview, sendAaTransfer } from './evm/op'
import type { AaOverview } from './evm/op'

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

function delegationLabel(chain: AaChainConfig, status?: string, implementation?: string): string {
  if (status === 'delegated') {
    return implementation && implementation.toLowerCase() !== chain.implementation.toLowerCase()
      ? '7702 其他实现'
      : '7702 已激活'
  }
  if (status === 'none') return '7702 未激活'
  if (status === 'contract') return '合约地址'
  return '7702 未知'
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
  // 默认以太坊 AA；用户切换后写入 localStorage，下次打开沿用。
  const [chainKey, setChainKey] = useState<string>(() => loadDefaultChainKey())
  const [overviews, setOverviews] = useState<Record<string, AaOverview>>({})
  const [assetSymbol, setAssetSymbol] = useState('USDC')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [transfer, setTransfer] = useState<TransferState>(EMPTY_TRANSFER)
  const [reveal, setReveal] = useState<{ address: string; privateKey: Hex } | null>(null)
  const [importKey, setImportKey] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')
  const [fingerprintReady, setFingerprintReady] = useState(false)
  const [fingerprintPassword, setFingerprintPassword] = useState('')
  const [webAuthnSupported] = useState(() => isWebAuthnSupported())
  const revealTimer = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setFingerprintReady(hasFingerprint())
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
  // 链只从注册表按 key 取；普通转账链（BSC / Ethereum）与 AA 链分开。
  const chain = getChain(chainKey) ?? BSC
  const aaChain: AaChainConfig | null = isAaChain(chain) ? chain : null
  const asset = aaChain ? (aaChain.assets.find((a) => a.symbol === assetSymbol) ?? aaChain.feeToken) : null
  const selectedOverview =
    aaChain && selected ? overviews[`${chain.key}:${selected.address}`] : undefined

  const changeChain = (key: string) => {
    const saved = saveDefaultChainKey(key)
    setChainKey(saved)
    const next = getChain(saved)
    setNotice(
      `默认链已保存：${next?.name ?? saved}${next && isAaChain(next) ? ' · AA' : ''}；下次打开直接进入`,
    )
  }

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

  const unlockWithPrint = async () => {
    if (!stored) return
    setBusy('正在验证指纹…')
    setError('')
    try {
      const pass = await unlockWithFingerprint()
      const next = await unlockVault(stored, pass)
      setOpened(next)
      setPassword('')
      setView('locked')
      setNotice('已用指纹解锁；密码与私钥只在当前页面内存中')
      void refreshBalances(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '指纹解锁失败')
    } finally {
      setBusy('')
    }
  }

  const enablePrint = async () => {
    if (!stored) return
    if (!fingerprintPassword) {
      setError('请输入当前钱包密码')
      return
    }
    setBusy('正在校验密码并创建指纹凭据…')
    setError('')
    let check: OpenedVault | null = null
    try {
      // 先校验密码，避免把输错的密码包装进指纹凭据。
      check = await unlockVault(stored, fingerprintPassword)
      await enableFingerprint(fingerprintPassword)
      setFingerprintPassword('')
      setFingerprintReady(true)
      setNotice('指纹解锁已启用；改密后需重新启用')
    } catch (e) {
      setError(e instanceof Error ? e.message : '启用指纹失败')
    } finally {
      if (check) closeVault(check)
      setBusy('')
    }
  }

  const disablePrint = () => {
    clearFingerprint()
    setFingerprintReady(false)
    setNotice('已停用指纹解锁；密码解锁仍可用')
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
      clearFingerprint()
      setFingerprintReady(false)
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
      clearFingerprint()
      setFingerprintReady(false)
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
    if (!aaChain) {
      const next: Record<string, string> = {}
      await Promise.all(
        active.map(async (w) => {
          try {
            const b = await getNativeBalance(chain, w.address)
            next[w.address] = b.amount
          } catch {
            next[w.address] = '读取失败'
          }
        }),
      )
      setBalances((old) => ({ ...old, ...next }))
      return
    }
    const next: Record<string, AaOverview> = {}
    await Promise.all(
      active.map(async (w) => {
        try {
          next[`${chain.key}:${w.address}`] = await getAaOverview(aaChain, w.address)
        } catch {
          /* 单地址失败不影响其他 */
        }
      }),
    )
    setOverviews((old) => ({ ...old, ...next }))
  }

  useEffect(() => {
    // 切换链后旧表单/资产不能沿用；余额按新链重新读。
    setTransfer(EMPTY_TRANSFER)
    if (aaChain && !aaChain.assets.some((item) => item.symbol === assetSymbol)) setAssetSymbol('USDC')
    if (opened) void refreshBalances(opened)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey])

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

  const changePass = async () => {
    if (!opened) return
    if (newPassword !== newPassword2) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy('正在用新密码重新加密…')
    setError('')
    try {
      const next = await changePassword(opened, newPassword)
      await saveStoredVault(next.data)
      clearFingerprint()
      setFingerprintReady(false)
      setStored(next.data)
      setOpened(next)
      setNewPassword('')
      setNewPassword2('')
      setNotice('已用新密码重新加密；旧密码与指纹解锁立即失效，请重新启用指纹并导出备份')
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改密码失败')
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
      const est = await estimateNativeTransfer(chain, {
        from: selected.address,
        to: transfer.to,
        amount: transfer.amount,
        gasPriceGwei: transfer.gasPrice,
      })
      setTransfer((s) => ({
        ...s,
        busy: false,
        result: `预估 gas ${est.gasLimit} × ${est.gasPrice} wei ≈ ${est.fee} ${chain.native.symbol}`,
      }))
    } catch (e) {
      setTransfer((s) => ({ ...s, busy: false, error: e instanceof Error ? e.message : '预估失败' }))
    }
  }

  const send = async () => {
    if (!selected) return
    if (
      !window.confirm(
        `确认从 ${selected.address} 在 ${chain.name} 转出 ${transfer.amount} ${chain.native.symbol} 到 ${transfer.to}？\n\n` +
          '交易将在本地签名后直接广播，不可撤销。',
      )
    ) {
      return
    }
    setTransfer((s) => ({ ...s, busy: true, error: '', result: '' }))
    try {
      const res = await sendNative(chain, {
        privateKey: selected.privateKey,
        to: transfer.to,
        amount: transfer.amount,
        gasPriceGwei: transfer.gasPrice,
      })
      setTransfer((s) => ({
        ...s,
        busy: false,
        result: `已广播：${res.hash}\n手续费：${res.fee} ${chain.native.symbol}`,
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

  const sendAa = async () => {
    if (!selected || !aaChain || !asset) return
    const cap = feeCapFor(aaChain, selectedOverview?.delegation.status === 'none')
    if (
      !window.confirm(
        `确认从 ${selected.address} 在 ${aaChain.name} 转出 ${transfer.amount} ${asset.symbol} 到 ${transfer.to}？\n\n` +
          `gas 用 USDC 支付；本次手续费上限 ${Number(cap) / 1e6} USDC。\n交易在本地签名，不可撤销。`,
      )
    ) {
      return
    }
    setTransfer((s) => ({ ...s, busy: true, error: '', result: '' }))
    try {
      const res = await sendAaTransfer(aaChain, {
        privateKey: selected.privateKey,
        to: transfer.to,
        amount: transfer.amount,
        asset: asset.symbol,
      })
      setTransfer((s) => ({
        ...s,
        busy: false,
        result: [
          `${aaChain.short} · ${asset.symbol}`,
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
              {fingerprintReady && webAuthnSupported ? (
                <button className="ghost" onClick={() => void unlockWithPrint()} disabled={Boolean(busy)}>
                  用指纹解锁
                </button>
              ) : null}
              {fingerprintReady && !webAuthnSupported ? (
                <p className="small muted">本机有指纹凭据，但当前环境不是安全上下文，请用密码解锁。</p>
              ) : null}
              <div className="row">
                <button className="ghost" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
                  导入另一个保险箱文件
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    if (!window.confirm('清除本浏览器保存的密文？已导出的备份不会被删除。')) return
                    void clearStoredVault().then(() => {
                      clearFingerprint()
                      setFingerprintReady(false)
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
          静态页面 · 无后端 · 直连公共 RPC · 密码/私钥不离开本机 · 构建{' '}
          {__BUILD_TIME__.slice(0, 16).replace('T', ' ')} UTC
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
            {activeWallets.length} 个钱包 · {chain.name}
            {aaChain ? ' · AA' : ''} · 已解锁
            {aaChain && selectedOverview ? (
              <>
                <br />
                {selectedOverview.assets.map((item) => `${item.balance} ${item.symbol}`).join(' · ')}
                {' · '}
                {selectedOverview.native} {chain.native.symbol}
              </>
            ) : !aaChain && selected ? (
              <>
                <br />
                {balances[selected.address] ?? '—'} {chain.native.symbol}
              </>
            ) : null}
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
        <select
          className="select"
          value={chainKey}
          onChange={(e) => changeChain(e.target.value)}
          aria-label="选择链"
        >
          {CHAINS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
              {isAaChain(c) ? ' · AA' : ' · 普通转账'}
            </option>
          ))}
        </select>
        {aaChain
          ? aaChain.assets.map((a) => {
              const balance = selectedOverview?.assets.find((item) => item.symbol === a.symbol)?.balance
              return (
                <button
                  key={a.symbol}
                  className={a.symbol === asset?.symbol ? 'primary' : 'ghost'}
                  onClick={() => setAssetSymbol(a.symbol)}
                >
                  {a.symbol}
                  {balance !== undefined ? ` ${balance}` : ''}
                </button>
              )
            })
          : null}
        <button className="ghost" onClick={() => changeChain(DEFAULT_CHAIN_KEY)}>
          默认 ETH AA
        </button>
        <span className="small muted">默认链保存在本机，切换只影响查询/转账，不改钱包</span>
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
          {activeWallets.map((w) => {
            const overview = aaChain ? overviews[`${chain.key}:${w.address}`] : undefined
            return (
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
                  {aaChain ? (
                    <div className="walletBalances mono">
                      {aaChain.assets.map((a) => (
                        <div key={a.symbol}>
                          {overview?.assets.find((item) => item.symbol === a.symbol)?.balance ?? '—'}{' '}
                          {a.symbol}
                        </div>
                      ))}
                      <div>
                        {overview?.native ?? '—'} {chain.native.symbol}
                      </div>
                    </div>
                  ) : (
                    <div className="mono">
                      {balances[w.address] ?? '—'} {chain.native.symbol}
                    </div>
                  )}
                  <div className="small muted">
                    {aaChain
                      ? delegationLabel(
                          aaChain,
                          overview?.delegation.status,
                          overview?.delegation.implementation,
                        )
                      : short(w.address)}
                  </div>
                </div>
              </button>
            )
          })}
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

        <details className="importRow">
          <summary className="small muted">修改钱包密码（重新加密）</summary>
          <div className="row">
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新密码（至少 12 位）"
              autoComplete="new-password"
            />
            <input
              type="password"
              value={newPassword2}
              onChange={(e) => setNewPassword2(e.target.value)}
              placeholder="再次输入新密码"
              autoComplete="new-password"
            />
            <button className="ghost" onClick={() => void changePass()} disabled={Boolean(busy)}>
              重新加密
            </button>
          </div>
          <p className="small muted">迁移后建议改一次密码，旧服务器用过的密码立即失效。</p>
        </details>

        <details className="importRow">
          <summary className="small muted">指纹解锁（WebAuthn PRF）</summary>
          {!webAuthnSupported ? (
            <p className="small muted">当前环境不支持 WebAuthn/指纹（需要 HTTPS 或 localhost）。</p>
          ) : fingerprintReady ? (
            <>
              <p className="small muted">
                已启用：只包装钱包密码，不碰私钥。改密、重新导入或清除本机数据后必须重新启用。
              </p>
              <button className="ghost" onClick={disablePrint} disabled={Boolean(busy)}>
                停用指纹解锁
              </button>
            </>
          ) : (
            <>
              <p className="small muted">
                启用后可用设备指纹/面容解锁；密码仍可手输。原始 PRF 与明文密码不落盘。
              </p>
              <div className="row">
                <input
                  type="password"
                  value={fingerprintPassword}
                  onChange={(e) => setFingerprintPassword(e.target.value)}
                  placeholder="当前钱包密码（启用指纹用）"
                  autoComplete="current-password"
                />
                <button className="ghost" onClick={() => void enablePrint()} disabled={Boolean(busy)}>
                  启用指纹
                </button>
              </div>
            </>
          )}
        </details>
      </section>

      <BatchPanel
        key={chain.key}
        wallets={activeWallets}
        chain={chain}
        aaChain={aaChain}
        asset={asset}
        defaultWalletId={selected?.id ?? null}
      />

      {selected ? (
        <>
          {!aaChain ? (
          <section className="card">
            <div className="row space">
              <h2>转账 · {chain.name}（{chain.native.symbol}）</h2>
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
                placeholder={`金额（${chain.native.symbol}）`}
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
          ) : aaChain ? (
          <section className="card">
            <div className="row space">
              <h2>转账 · {aaChain.name} · {asset?.symbol}</h2>
              <span className="small muted">#{selected.id} {short(selected.address)}</span>
            </div>
            <p className="small muted">
              {aaChain.assets
                .map(
                  (a) =>
                    `${a.symbol} ${selectedOverview?.assets.find((x) => x.symbol === a.symbol)?.balance ?? '—'}`,
                )
                .join(' · ')}
              {' · '}原生 {selectedOverview?.native ?? '—'} {aaChain.native.symbol}
              {' · '}状态：
              {delegationLabel(
                aaChain,
                selectedOverview?.delegation.status,
                selectedOverview?.delegation.implementation,
              )}
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
              placeholder={`金额（${asset?.symbol ?? ''}）`}
              inputMode="decimal"
            />
            <div className="row">
              <button className="primary" onClick={() => void sendAa()} disabled={transfer.busy || !asset}>
                {transfer.busy ? '签名/提交中…' : '本地签名并提交 UserOp'}
              </button>
            </div>
            {transfer.result ? <pre className="result">{transfer.result}</pre> : null}
            {transfer.error ? <div className="error">{transfer.error}</div> : null}
            <p className="small muted">
              gas 用 USDC 支付（permit 上限 {aaChain.feeCapUsdc}，首次激活 {aaChain.firstFeeCapUsdc} USDC）；
              permit/UserOp/7702 授权全部本地签名，bundler 只收到已签名 UserOp。建议先用 0.01 验证。
            </p>
          </section>
          ) : null}

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
        本地签名 · 直连公共 RPC · 服务器不接触密码/私钥 · 构建{' '}
        {__BUILD_TIME__.slice(0, 16).replace('T', ' ')} UTC。大额建议使用硬件钱包或多签。
      </footer>
    </div>
  )
}
