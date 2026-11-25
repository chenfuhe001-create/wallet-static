import { useEffect, useState } from 'react'
import { parseUnits } from 'viem'
import type { Hex } from 'viem'
import { feeCapFor, getAsset } from './chains'
import type { AaChainConfig, ChainConfig, TokenAsset } from './chains'
import { clearBatch, loadBatch, saveBatch } from './batchStorage'
import {
  buildPlan,
  isRetryable,
  parseRecipients,
  recoverBatch,
  runBatch,
} from './evm/batch'
import type {
  BatchItem,
  BatchItemStatus,
  BatchMode,
  BatchPlanItem,
  BatchSenderAdapter,
} from './evm/batch'
import { estimateNativeTransfer, getNativeBalance, getNativeGasPrice, sendNative } from './evm/native'
import { getAaOverview, getBundlerGasPrice, sendAaTransfer } from './evm/op'
import { reconcileErc20Batch, reconcileUserOps } from './evm/reconcile'
import type { ReconcileOutcome } from './evm/reconcile'
import { BroadcastError, rpcRead } from './rpc'

interface Props {
  wallets: Array<{ id: number; address: string; privateKey: Hex; label: string }>
  chain: ChainConfig
  aaChain: AaChainConfig | null
  asset: TokenAsset | null
  defaultWalletId: number | null
}

const STATUS_LABEL: Record<BatchItemStatus, string> = {
  queued: '排队',
  signing: '本地签名',
  submitting: '提交广播',
  waiting: '等待回执',
  success: '成功',
  failed: '失败',
  unknown: '结果不明',
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** 把单笔发送函数包装成批量适配器：预检余额、串行节流、区分“已广播/未广播”。 */
function makeAdapters(
  wallets: Props['wallets'],
  chain: ChainConfig,
  aaChain: AaChainConfig | null,
  assetSymbol: string,
): Map<string, BatchSenderAdapter> {
  const adapters = new Map<string, BatchSenderAdapter>()
  const explorer = chain.explorerTx ?? ''

  for (const wallet of wallets) {
    if (!aaChain) {
      adapters.set(wallet.address, {
        address: wallet.address,
        minIntervalMs: 800,
        async precheck(amount, to) {
          const balance = await getNativeBalance(chain, wallet.address)
          const value = parseUnits(amount, chain.native.decimals)
          if (balance.wei < value) return `${chain.native.symbol} 余额不足以支付金额`
          const estimate = await estimateNativeTransfer(chain, {
            from: wallet.address,
            to,
            amount,
          })
          if (balance.wei < value + parseUnits(estimate.fee, chain.native.decimals)) {
            return `${chain.native.symbol} 余额不足以支付手续费`
          }
          return null
        },
        async send(to, amount) {
          try {
            const res = await sendNative(chain, { privateKey: wallet.privateKey, to, amount })
            return {
              status: res.status,
              hash: res.hash,
              fee: `${res.fee} ${chain.native.symbol}`,
              explorer: explorer ? `${explorer}${res.hash}` : undefined,
            }
          } catch (err) {
            // 已上链但执行失败：哈希必须留下，批量不得重发。
            if (err instanceof BroadcastError) {
              return {
                status: 'failed',
                hash: err.hash,
                explorer: explorer ? `${explorer}${err.hash}` : undefined,
              }
            }
            throw err
          }
        },
      })
      continue
    }

    const aa = aaChain
    adapters.set(wallet.address, {
      address: wallet.address,
      minIntervalMs: 1500,
      async precheck(amount) {
        const token = getAsset(aa, assetSymbol)
        const overview = await getAaOverview(aa, wallet.address)
        const cap = feeCapFor(aa, overview.delegation.status === 'none')
        const balanceOf = (symbol: string) =>
          parseUnits(overview.assets.find((item) => item.symbol === symbol)?.balance ?? '0', 6)
        const value = parseUnits(amount, token.decimals)
        const feeIsAsset = token.address.toLowerCase() === aa.feeToken.address.toLowerCase()
        if (feeIsAsset) {
          if (balanceOf(aa.feeToken.symbol) < value + cap) {
            return `${aa.feeToken.symbol} 余额不足以支付金额和手续费上限`
          }
        } else {
          if (balanceOf(aa.feeToken.symbol) < cap) {
            return `${aa.feeToken.symbol} 余额不足以支付手续费上限`
          }
          if (balanceOf(token.symbol) < value) return `${token.symbol} 余额不足`
        }
        return null
      },
      async send(to, amount) {
        const res = await sendAaTransfer(aa, {
          privateKey: wallet.privateKey,
          to,
          amount,
          asset: assetSymbol,
        })
        return {
          status: res.status,
          hash: res.txHash,
          userOpHash: res.userOpHash,
          fee: res.feeUsdc ? `${res.feeUsdc} USDC` : undefined,
          explorer: res.explorer,
        }
      },
    })
  }

  return adapters
}

export default function BatchPanel({ wallets, chain, aaChain, asset, defaultWalletId }: Props) {
  const [mode, setMode] = useState<BatchMode>('one-to-many')
  const [senderId, setSenderId] = useState<number | null>(defaultWalletId ?? wallets[0]?.id ?? null)
  const [senderIds, setSenderIds] = useState<number[]>([])
  const [recipientText, setRecipientText] = useState('')
  const [amount, setAmount] = useState('')
  const [items, setItems] = useState<BatchItem[]>([])
  const [storedAsset, setStoredAsset] = useState('')
  const [running, setRunning] = useState(false)
  const [diagnosing, setDiagnosing] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const assetSymbol = asset?.symbol ?? chain.native.symbol

  useEffect(() => {
    const stored = loadBatch(chain.id)
    if (stored?.items.length) {
      setItems(recoverBatch(stored.items))
      setStoredAsset(stored.asset)
      setNotice('已恢复上次批次；未完成笔标为「结果不明」，请先核对链上')
    } else {
      setItems([])
      setStoredAsset('')
    }
  }, [chain.id])

  useEffect(() => {
    if (!items.length) return
    saveBatch(chain.id, storedAsset || assetSymbol, items)
  }, [items, chain.id, storedAsset, assetSymbol])

  const toggleSender = (id: number) => {
    setSenderIds((old) => (old.includes(id) ? old.filter((item) => item !== id) : [...old, id]))
  }

  const execute = async (planItems: BatchPlanItem[]) => {
    setRunning(true)
    setError('')
    setNotice('')
    try {
      const adapters = makeAdapters(wallets, chain, aaChain, planItems[0].asset)
      await runBatch(planItems, adapters, {
        concurrency: 3,
        onUpdate: (item) => setItems((old) => old.map((row) => (row.id === item.id ? { ...item } : row))),
      })
      setNotice('批次执行完毕；成功笔不可回滚，结果不明笔请先核对链上')
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量执行失败')
    } finally {
      setRunning(false)
    }
  }

  const start = async () => {
    const parsed = parseRecipients(recipientText)
    if (parsed.invalid.length) {
      setError(`第 ${parsed.invalid.map((item) => item.line).join('、')} 行不是合法地址：${parsed.invalid[0].value}`)
      return
    }
    if (!parsed.addresses.length) {
      setError('请填写至少一个收款地址')
      return
    }
    if (mode === 'many-to-one' && parsed.addresses.length !== 1) {
      setError('多个钱包 → 一个地址只接受 1 个收款地址')
      return
    }
    const senders =
      mode === 'one-to-many'
        ? wallets.filter((wallet) => wallet.id === senderId).map((wallet) => wallet.address)
        : wallets.filter((wallet) => senderIds.includes(wallet.id)).map((wallet) => wallet.address)
    if (!senders.length) {
      setError(mode === 'one-to-many' ? '请选择发送钱包' : '请至少勾选一个发送钱包')
      return
    }

    let planItems: BatchPlanItem[]
    try {
      planItems = buildPlan({
        mode,
        senders,
        recipients: mode === 'one-to-many' ? parsed.addresses : [parsed.addresses[0]],
        amount,
        asset: assetSymbol,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '批次参数不正确')
      return
    }

    if (
      !window.confirm(
        `确认执行 ${planItems.length} 笔？\n每笔 ${planItems[0].amount} ${planItems[0].asset}，逐笔本地签名、逐笔广播（非原子，失败不回滚已成功笔）。`,
      )
    ) {
      return
    }

    const fresh: BatchItem[] = planItems.map((item, index) => ({
      ...item,
      index: index + 1,
      status: 'queued',
      broadcasted: false,
    }))
    setItems(fresh)
    setStoredAsset(planItems[0].asset)
    saveBatch(chain.id, planItems[0].asset, fresh)
    await execute(planItems)
  }

  const retry = async () => {
    const targets = items.filter(isRetryable).map((item) => ({
      id: item.id,
      from: item.from,
      to: item.to,
      amount: item.amount,
      asset: item.asset,
      index: item.index,
    }))
    if (!targets.length) return
    if (!window.confirm(`只重试从未广播的 ${targets.length} 笔？已有哈希的失败笔不会重发。`)) return
    setItems((old) =>
      old.map((item) =>
        targets.some((target) => target.id === item.id)
          ? { ...item, status: 'queued', broadcasted: false, error: undefined }
          : item,
      ),
    )
    await execute(targets)
  }

  const reconcile = async () => {
    if (!aaChain) return
    const pending = items.filter(
      (item) => item.status === 'unknown' || (item.status === 'failed' && !item.broadcasted),
    )
    if (!pending.length) {
      setNotice('没有需要核对的结果不明项')
      return
    }
    setReconciling(true)
    setError('')
    setNotice('正在按 UserOp 回执与 USDC Transfer 日志核对…')
    try {
      const outcomes = new Map<string, ReconcileOutcome>()
      for (const outcome of await reconcileUserOps(aaChain, pending)) outcomes.set(outcome.id, outcome)
      const remaining = pending.filter((item) => {
        const outcome = outcomes.get(item.id)
        // 有 UserOp 哈希但暂无回执：可能仍在打包，保持不明，不交给日志判失败。
        if (outcome?.status === 'unknown' && item.userOpHash) return false
        return !outcome || outcome.status === 'unknown'
      })
      if (remaining.length) {
        for (const outcome of await reconcileErc20Batch(aaChain, remaining)) {
          outcomes.set(outcome.id, outcome)
        }
      }

      const results = [...outcomes.values()]
      const success = results.filter((outcome) => outcome.status === 'success').length
      const notFound = results.filter((outcome) => outcome.status === 'failed').length
      const unknown = results.filter((outcome) => outcome.status === 'unknown').length
      setItems((old) =>
        old.map((item) => {
          const outcome = outcomes.get(item.id)
          if (!outcome) return item
          if (outcome.status === 'success') {
            return {
              ...item,
              status: 'success' as const,
              broadcasted: true,
              hash: outcome.hash ?? item.hash,
              error: undefined,
            }
          }
          if (outcome.status === 'failed') {
            return {
              ...item,
              status: 'failed' as const,
              broadcasted: false,
              error: outcome.note,
            }
          }
          return { ...item, error: outcome.note }
        }),
      )
      setNotice(`核对完成：成功 ${success} · 未找到 ${notFound} · 仍不明 ${unknown}`)
    } catch (err) {
      setNotice('')
      setError(`核对失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setReconciling(false)
    }
  }

  const diagnose = async () => {
    setDiagnosing(true)
    setError('')
    setNotice('正在检测当前链的 RPC/bundler…')
    try {
      const raw = await rpcRead<string>(chain.rpc, 'eth_chainId', [])
      const actual = BigInt(raw)
      if (actual !== BigInt(chain.id)) {
        throw new Error(`RPC chainId=${actual}，不是 ${chain.short}(${chain.id})`)
      }
      if (aaChain) {
        const gas = await getBundlerGasPrice(aaChain)
        setNotice(`RPC 正常（chainId ${chain.id}）；bundler gas ${gas.maxFeePerGas} wei`)
      } else {
        const gas = await getNativeGasPrice(chain)
        setNotice(`RPC 正常（chainId ${chain.id}）；gasPrice ${gas} wei`)
      }
    } catch (err) {
      setNotice('')
      setError(`网络诊断失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDiagnosing(false)
    }
  }

  const clear = () => {
    if (items.length && !window.confirm('清除本机保存的批次记录？链上交易不受影响。')) return
    clearBatch(chain.id)
    setItems([])
    setStoredAsset('')
    setNotice('已清除批次记录')
  }

  const retryable = items.filter(isRetryable).length
  const succeeded = items.filter((item) => item.status === 'success').length
  const failed = items.filter((item) => item.status === 'failed' || item.status === 'unknown').length

  return (
    <details className="card batchPanel">
      <summary className="batchSummary">
        批量转账 · 逐笔签名（非原子）{items.length ? ` · ${items.length} 笔` : ''}
      </summary>

      <div className="row chainTabs">
        <button
          className={mode === 'one-to-many' ? 'primary' : 'ghost'}
          onClick={() => setMode('one-to-many')}
          disabled={running}
        >
          一个钱包 → 多个地址
        </button>
        <button
          className={mode === 'many-to-one' ? 'primary' : 'ghost'}
          onClick={() => setMode('many-to-one')}
          disabled={running}
        >
          多个钱包 → 一个地址
        </button>
      </div>

      {mode === 'one-to-many' ? (
        <>
          <label className="small muted" htmlFor="batchSender">
            发送钱包
          </label>
          <select
            id="batchSender"
            className="select"
            value={senderId ?? ''}
            onChange={(e) => setSenderId(Number(e.target.value))}
            disabled={running}
          >
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                #{wallet.id} {wallet.label || short(wallet.address)}
              </option>
            ))}
          </select>
          <textarea
            value={recipientText}
            onChange={(e) => setRecipientText(e.target.value)}
            placeholder={`每行一个收款地址（${assetSymbol}）\n0x…\n0x…`}
            rows={4}
            spellCheck={false}
            disabled={running}
          />
        </>
      ) : (
        <>
          <div className="small muted">勾选发送钱包（同一个收款地址）</div>
          <div className="list">
            {wallets.map((wallet) => (
              <label key={wallet.id} className="batchCheck">
                <input
                  type="checkbox"
                  checked={senderIds.includes(wallet.id)}
                  onChange={() => toggleSender(wallet.id)}
                  disabled={running}
                />
                <span>
                  #{wallet.id} {wallet.label || short(wallet.address)}
                </span>
              </label>
            ))}
          </div>
          <input
            value={recipientText}
            onChange={(e) => setRecipientText(e.target.value)}
            placeholder="收款地址 0x…（只能 1 个）"
            spellCheck={false}
            disabled={running}
          />
        </>
      )}

      <div className="row">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`每笔金额（${assetSymbol}）`}
          inputMode="decimal"
          disabled={running}
        />
        <button className="primary" onClick={() => void start()} disabled={running || !wallets.length}>
          {running ? '批量执行中…' : '开始批量转账'}
        </button>
        {aaChain ? (
          <button
            className="ghost"
            onClick={() => void reconcile()}
            disabled={running || reconciling}
          >
            {reconciling ? '核对中…' : '核对结果不明项'}
          </button>
        ) : null}
        <button className="ghost" onClick={() => void diagnose()} disabled={running || diagnosing}>
          {diagnosing ? '检测中…' : '网络诊断'}
        </button>
        <button className="ghost" onClick={clear} disabled={running || !items.length}>
          清除记录
        </button>
      </div>

      <p className="small muted">
        同一发送钱包串行（AA ≥1.5s / BSC ≥0.8s），不同钱包最多 3 个并发；每笔广播前检查余额与手续费上限。
        公共 Pimlico 约 12 次/分钟会限流（约 30 秒恢复），本页已把 bundler 请求节流到 6 秒/次；
        9 笔批量约 4 分钟，请勿关闭页面。已广播的失败笔不会自动重发；结果不明项可点「核对结果不明项」。
      </p>
      {storedAsset && storedAsset !== assetSymbol ? (
        <p className="small muted">上次批次资产：{storedAsset}（重试仍按该资产）</p>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {items.length ? (
        <>
          <div className="row space batchSummary">
            <span className="small muted">
              成功 {succeeded} · 失败/不明 {failed} · 可重试 {retryable}
            </span>
            <button className="ghost" onClick={() => void retry()} disabled={running || !retryable}>
              重试未广播失败项
            </button>
          </div>
          <div className="list">
            {items.map((item) => (
              <div key={item.id} className="batchItem">
                <div className="row space">
                  <span className="small">
                    #{item.index} {short(item.from)} → {short(item.to)}
                  </span>
                  <span className={`batchStatus ${item.status}`}>{STATUS_LABEL[item.status]}</span>
                </div>
                <div className="small muted">
                  {item.amount} {item.asset}
                  {item.fee ? ` · 手续费 ${item.fee}` : ''}
                </div>
                {item.error ? <div className="small batchError">{item.error}</div> : null}
                {item.status === 'unknown' && !item.hash ? (
                  <div className="small muted">
                    没有记录到哈希；请先核对发送地址的 nonce/交易记录，再决定是否重试。
                  </div>
                ) : null}
                {item.status === 'failed' || item.status === 'unknown' ? (
                  <a
                    className="small"
                    href={`${(chain.explorerTx ?? '').replace('/tx/', '/address/')}${item.from}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    核对发送地址
                  </a>
                ) : null}
                {item.hash ? (
                  <a
                    className="mono small"
                    href={`${chain.explorerTx ?? ''}${item.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.hash}
                  </a>
                ) : null}
                {item.userOpHash ? (
                  <div className="mono small">UserOp {short(item.userOpHash)}</div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </details>
  )
}
