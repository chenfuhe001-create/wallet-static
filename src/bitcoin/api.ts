/** Blockstream Esplora 客户端；mempool.space 作为备用。只读地址/UTXO/费率，广播只发已签名 raw tx。 */

import type { BitcoinFeeRates, BitcoinTxStatus, BitcoinUtxo } from './types'
import { feeRatesFromEstimates } from './fees'

export const BTC_API_ENDPOINTS = ['https://blockstream.info/api', 'https://mempool.space/api'] as const
const TIMEOUT_MS = 20_000

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 160)}` : ''}`)
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function withFallback<T>(path: string, parse: (text: string) => T, init: RequestInit = {}): Promise<T> {
  let last: unknown
  for (const base of BTC_API_ENDPOINTS) {
    try {
      return parse(await fetchText(`${base}${path}`, init))
    } catch (err) {
      last = err
    }
  }
  throw new Error(`比特币 API 不可用：${last instanceof Error ? last.message : String(last)}`)
}

interface EsploraUtxo {
  txid: string
  vout: number
  value: number
  status?: { confirmed?: boolean; block_height?: number }
}

export async function fetchUtxos(address: string): Promise<BitcoinUtxo[]> {
  return withFallback(`/address/${encodeURIComponent(address)}/utxo`, (text) => {
    const rows = JSON.parse(text) as EsploraUtxo[]
    if (!Array.isArray(rows)) throw new Error('UTXO 返回格式不正确')
    return rows.map((row) => ({
      txid: String(row.txid),
      vout: Number(row.vout),
      value: BigInt(row.value),
      confirmed: row.status?.confirmed === true,
    }))
  })
}

export async function fetchFeeRates(): Promise<BitcoinFeeRates> {
  try {
    const raw = await withFallback('/fee-estimates', (text) => JSON.parse(text) as Record<string, number>)
    return feeRatesFromEstimates(raw)
  } catch {
    // mempool.space 的 recommended 结构与 Esplora 不同
    const raw = await fetchText('https://mempool.space/api/v1/fees/recommended')
    const parsed = JSON.parse(raw) as {
      fastestFee?: number
      halfHourFee?: number
      hourFee?: number
      economyFee?: number
    }
    return {
      fast: Math.max(1, Math.ceil(parsed.fastestFee ?? 1)),
      normal: Math.max(1, Math.ceil(parsed.halfHourFee ?? parsed.hourFee ?? 1)),
      slow: Math.max(1, Math.ceil(parsed.economyFee ?? parsed.hourFee ?? 1)),
    }
  }
}

export async function fetchTxStatus(txid: string): Promise<BitcoinTxStatus | null> {
  for (const base of BTC_API_ENDPOINTS) {
    try {
      const text = await fetchText(`${base}/tx/${encodeURIComponent(txid)}/status`)
      const row = JSON.parse(text) as { confirmed?: boolean; block_height?: number }
      return { confirmed: row.confirmed === true, blockHeight: row.block_height }
    } catch (err) {
      // 404 表示还没被节点看到；其他错误换端点
      if (err instanceof Error && /HTTP 404/.test(err.message)) continue
    }
  }
  return null
}

/** 返回节点给出的 txid；同一个 raw tx 重播是幂等的。 */
export async function broadcastTx(rawHex: string): Promise<string> {
  let last: unknown
  for (const base of BTC_API_ENDPOINTS) {
    try {
      const text = await fetchText(`${base}/tx`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: rawHex,
      })
      const txid = text.trim()
      if (/^[0-9a-fA-F]{64}$/.test(txid)) return txid.toLowerCase()
      throw new Error('广播返回的 txid 格式不正确')
    } catch (err) {
      last = err
    }
  }
  throw new Error(`比特币广播失败：${last instanceof Error ? last.message : String(last)}`)
}
