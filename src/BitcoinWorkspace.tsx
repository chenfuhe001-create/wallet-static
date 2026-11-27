import { useEffect, useMemo, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import type { Hex } from 'viem'
import { btcAddressFromPrivateKey, validateBitcoinAddress } from './bitcoin/address'
import { fetchFeeRates } from './bitcoin/api'
import { feeRatesFromEstimates } from './bitcoin/fees'
import { estimateBitcoinTransfer, sendBitcoin, BitcoinAmbiguousError, waitForBitcoinTx } from './bitcoin/send'
import type { BitcoinBalance, BitcoinFeeRates } from './bitcoin/types'

interface Props {
  wallets: Array<{ id: number; address: string; privateKey: Hex; label: string }>
  balances: Record<number, BitcoinBalance>
  selectedId: number | null
  onSelect: (id: number) => void
  onRefresh: () => void
  onNotice: (message: string) => void
}

const DEFAULT_FEES: BitcoinFeeRates = { fast: 1, normal: 1, slow: 1 }

function short(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}

function btc(value: bigint): string {
  return formatUnits(value, 8)
}

export default function BitcoinWorkspace({
  wallets,
  balances,
  selectedId,
  onSelect,
  onRefresh,
  onNotice,
}: Props) {
  const selected = wallets.find((wallet) => wallet.id === selectedId) ?? wallets[0] ?? null
  const [fees, setFees] = useState<BitcoinFeeRates>(DEFAULT_FEES)
  const [feePreset, setFeePreset] = useState<'fast' | 'normal' | 'slow' | 'custom'>('normal')
  const [customRate, setCustomRate] = useState('')
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [preview, setPreview] = useState<{
    feeSats: bigint
    vsize: number
    changeSats: bigint
    inputCount: number
    confirmedSats: bigint
  } | null>(null)

  const address = useMemo(
    () => (selected ? btcAddressFromPrivateKey(selected.privateKey) : ''),
    [selected],
  )
  const balance = selected ? balances[selected.id] : undefined
  const feeRate =
    feePreset === 'custom'
      ? Math.max(1, Math.ceil(Number(customRate) || 0))
      : Math.max(1, fees[feePreset])

  useEffect(() => {
    void fetchFeeRates()
      .then((next) => setFees(next))
      .catch(() => setFees(feeRatesFromEstimates({})))
  }, [])

  const amountSats = (): bigint => {
    const raw = amount.trim()
    if (!raw || !(Number(raw) > 0)) throw new Error('金额必须大于 0')
    const value = parseUnits(raw, 8)
    if (value <= 0n) throw new Error('金额必须大于 0')
    return value
  }

  const estimate = async () => {
    if (!selected) return
    setBusy(true)
    setError('')
    setResult('')
    try {
      validateBitcoinAddress(to)
      const next = await estimateBitcoinTransfer({
        privateKey: selected.privateKey,
        to: to.trim(),
        amountSats: amountSats(),
        feeRate,
      })
      setPreview(next)
    } catch (err) {
      setPreview(null)
      setError(err instanceof Error ? err.message : '预估失败')
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!selected) return
    setError('')
    setResult('')
    setBusy(true)
    try {
      validateBitcoinAddress(to)
      const value = amountSats()
      const estimateResult = await estimateBitcoinTransfer({
        privateKey: selected.privateKey,
        to: to.trim(),
        amountSats: value,
        feeRate,
      })
      setPreview(estimateResult)
      if (
        !window.confirm(
          `确认从 ${address} 转出 ${formatUnits(value, 8)} BTC 到 ${to.trim()}？\n\n` +
            `手续费约 ${btc(estimateResult.feeSats)} BTC（${feeRate} sat/vB，${estimateResult.vsize} vB）\n` +
            `找零 ${btc(estimateResult.changeSats)} BTC，输入 ${estimateResult.inputCount} 个 UTXO。\n` +
            '交易在本地签名后广播，不可撤销。',
        )
      ) {
        return
      }
      const sent = await sendBitcoin({
        privateKey: selected.privateKey,
        to: to.trim(),
        amountSats: value,
        feeRate,
      })
      setResult(
        [
          `已广播：${sent.txid}`,
          `手续费：${btc(sent.feeSats)} BTC（${sent.vsize} vB）`,
          'https://blockstream.info/tx/' + sent.txid,
        ].join('\n'),
      )
      onNotice('比特币交易已广播；确认后余额才会更新')
      onRefresh()
      void waitForBitcoinTx(sent.txid, 180_000).then((status) => {
        if (status === 'confirmed') {
          setResult((current) => `${current}\n状态：已确认`)
          onRefresh()
        }
      })
    } catch (err) {
      if (err instanceof BitcoinAmbiguousError) {
        setError(`${err.message}\n请先在区块浏览器核对 txid，不要直接重发。`)
        onRefresh()
      } else {
        setError(err instanceof Error ? err.message : '发送失败')
      }
    } finally {
      setBusy(false)
    }
  }

  if (!wallets.length || !selected) {
    return <p className="small muted">没有可用钱包。</p>
  }

  return (
    <>
      <section className="card">
        <div className="row space">
          <h2>Bitcoin 钱包</h2>
          <span className="small muted">{wallets.length} 个地址 · 主网 P2WPKH</span>
        </div>
        <div className="list">
          {wallets.map((wallet) => {
            const walletAddress = btcAddressFromPrivateKey(wallet.privateKey)
            const row = balances[wallet.id]
            return (
              <button
                key={wallet.id}
                className={`walletRow ${selected.id === wallet.id ? 'active' : ''}`}
                onClick={() => onSelect(wallet.id)}
              >
                <div>
                  <div className="walletTitle">
                    #{wallet.id} {wallet.label || '未命名'}
                  </div>
                  <div className="mono small">{walletAddress}</div>
                </div>
                <div className="right">
                  <div className="mono">{row ? `${btc(row.total)} BTC` : '—'}</div>
                  <div className="small muted">
                    {row && row.unconfirmed > 0n ? `未确认 ${btc(row.unconfirmed)}` : '仅统计已确认 UTXO'}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      <section className="card">
        <div className="row space">
          <h2>转账 · Bitcoin · BTC</h2>
          <span className="small muted">#{selected.id} {short(address)}</span>
        </div>
        <p className="small muted">
          同一个私钥的 EVM 地址：{selected.address}。同一密钥同时控制 EVM 与 BTC，请注意关联风险。
        </p>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          placeholder="比特币主网收款地址（bc1… / 1… / 3…）"
          spellCheck={false}
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="金额（BTC）"
          inputMode="decimal"
        />
        <div className="row">
          <label className="small muted" htmlFor="btcFee">费率</label>
          <select
            id="btcFee"
            className="select"
            value={feePreset}
            onChange={(e) => setFeePreset(e.target.value as typeof feePreset)}
          >
            <option value="fast">快（{fees.fast} sat/vB）</option>
            <option value="normal">正常（{fees.normal} sat/vB）</option>
            <option value="slow">慢（{fees.slow} sat/vB）</option>
            <option value="custom">自定义</option>
          </select>
          {feePreset === 'custom' ? (
            <input
              value={customRate}
              onChange={(e) => setCustomRate(e.target.value)}
              placeholder="sat/vB"
              inputMode="numeric"
            />
          ) : null}
        </div>
        <div className="row">
          <button className="ghost" onClick={() => void estimate()} disabled={busy}>
            {busy ? '处理中…' : '预估手续费'}
          </button>
          <button className="primary" onClick={() => void send()} disabled={busy}>
            {busy ? '签名/广播中…' : '本地签名并广播'}
          </button>
        </div>
        {preview ? (
          <p className="small muted">
            预估：手续费 {btc(preview.feeSats)} BTC（{preview.vsize} vB） · 找零 {btc(preview.changeSats)} BTC ·
            输入 {preview.inputCount} 个 UTXO · 已确认余额 {btc(preview.confirmedSats)} BTC
          </p>
        ) : null}
        {result ? <pre className="result">{result}</pre> : null}
        {error ? <div className="error">{error}</div> : null}
        <p className="small muted">
          比特币地址簿不保存 BTC 地址（地址簿只存 EVM，和 web 完全互导）；请手动填写。
          广播只发已签名 raw tx，不经过服务器。
        </p>
      </section>
    </>
  )
}
