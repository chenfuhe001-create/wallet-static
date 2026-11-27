/** 比特币费率与 UTXO 选择：金额全部用 satoshi bigint。 */

import type { BitcoinFeeRates, BitcoinUtxo } from './types'

export const DUST_SATS = 546n
export const MAX_INPUTS = 50

/** P2WPKH：10.5 vB 固定 + 68 vB/输入 + 31 vB/输出，向上取整。 */
export function estimateVsize(inputs: number, outputs: number): number {
  return Math.ceil(10.5 + 68 * inputs + 31 * outputs)
}

export function feeFor(inputs: number, outputs: number, feeRate: number): bigint {
  const rate = Math.max(1, Math.ceil(Number(feeRate) || 0))
  return BigInt(Math.ceil(estimateVsize(inputs, outputs) * rate))
}

export function feeRatesFromEstimates(raw: Record<string, number>): BitcoinFeeRates {
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      const value = Number(raw?.[key])
      if (Number.isFinite(value) && value > 0) return Math.max(1, Math.ceil(value))
    }
    return 1
  }
  return {
    fast: pick('1', '2'),
    normal: pick('3', '6'),
    slow: pick('144', '1008'),
  }
}

export interface SelectedUtxos {
  inputs: BitcoinUtxo[]
  total: bigint
  fee: bigint
  change: bigint
  vsize: number
}

/** 简单最大优先选择；只花 confirmed。找零低于粉尘就并入手续费。 */
export function selectUtxos(utxos: BitcoinUtxo[], amount: bigint, feeRate: number): SelectedUtxos {
  if (amount <= 0n) throw new Error('金额必须大于 0')
  const usable = utxos.filter((utxo) => utxo.confirmed && utxo.value > 0n).sort((a, b) => (a.value < b.value ? 1 : -1))
  if (!usable.length) throw new Error('没有可用的已确认 BTC（未确认余额需等待确认）')

  const inputs: BitcoinUtxo[] = []
  let total = 0n
  for (const utxo of usable) {
    if (inputs.length >= MAX_INPUTS) break
    inputs.push(utxo)
    total += utxo.value
    const withChange = feeFor(inputs.length, 2, feeRate)
    if (total >= amount + withChange) {
      const change = total - amount - withChange
      if (change >= DUST_SATS) {
        return { inputs, total, fee: withChange, change, vsize: estimateVsize(inputs.length, 2) }
      }
      const noChangeFee = total - amount
      if (noChangeFee >= feeFor(inputs.length, 1, feeRate)) {
        return { inputs, total, fee: noChangeFee, change: 0n, vsize: estimateVsize(inputs.length, 1) }
      }
    }
  }
  throw new Error('BTC 余额不足以支付金额和手续费（仅统计已确认 UTXO）')
}
