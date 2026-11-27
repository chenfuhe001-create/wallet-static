/** 比特币单笔转账编排：拉 UTXO → 本地签名 → 广播 → 结果不明时按 txid 核对。 */

import type { Hex } from 'viem'
import { btcAddressFromPrivateKey } from './address'
import { broadcastTx, fetchTxStatus, fetchUtxos } from './api'
import { selectUtxos } from './fees'
import { buildBitcoinTransfer } from './tx'
import type { BitcoinBalance, BitcoinSendResult, BitcoinUtxo } from './types'

export class BitcoinAmbiguousError extends Error {
  constructor(message: string, readonly txid: string) {
    super(message)
    this.name = 'BitcoinAmbiguousError'
  }
}

export async function fetchBitcoinBalance(privateKey: Hex): Promise<BitcoinBalance> {
  const address = btcAddressFromPrivateKey(privateKey)
  const utxos = await fetchUtxos(address)
  let confirmed = 0n
  let unconfirmed = 0n
  for (const utxo of utxos) {
    if (utxo.confirmed) confirmed += utxo.value
    else unconfirmed += utxo.value
  }
  return { confirmed, unconfirmed, total: confirmed + unconfirmed }
}

export async function estimateBitcoinTransfer(input: {
  privateKey: Hex
  to: string
  amountSats: bigint
  feeRate: number
}): Promise<{ feeSats: bigint; vsize: number; changeSats: bigint; inputCount: number; confirmedSats: bigint }> {
  const address = btcAddressFromPrivateKey(input.privateKey)
  const utxos = await fetchUtxos(address)
  const selected = selectUtxos(utxos, input.amountSats, input.feeRate)
  return {
    feeSats: selected.fee,
    vsize: selected.vsize,
    changeSats: selected.change,
    inputCount: selected.inputs.length,
    confirmedSats: utxos.filter((utxo) => utxo.confirmed).reduce((sum, utxo) => sum + utxo.value, 0n),
  }
}

export async function sendBitcoin(input: {
  privateKey: Hex
  to: string
  amountSats: bigint
  feeRate: number
}): Promise<BitcoinSendResult> {
  const address = btcAddressFromPrivateKey(input.privateKey)
  const utxos: BitcoinUtxo[] = await fetchUtxos(address)
  const built = buildBitcoinTransfer({
    privateKey: input.privateKey,
    to: input.to,
    amountSats: input.amountSats,
    feeRate: input.feeRate,
    utxos,
  })

  let firstError: unknown = null
  try {
    const returned = await broadcastTx(built.hex)
    if (returned !== built.txid) {
      throw new BitcoinAmbiguousError(
        `广播返回的 txid 与本地不一致（本地 ${built.txid}，节点 ${returned}）`,
        built.txid,
      )
    }
  } catch (err) {
    if (err instanceof BitcoinAmbiguousError) throw err
    firstError = err
    const status = await fetchTxStatus(built.txid).catch(() => null)
    if (!status) {
      // 同一个 raw tx 重播是幂等的；绝不重新选 UTXO 构造第二笔。
      try {
        await broadcastTx(built.hex)
      } catch {
        throw new BitcoinAmbiguousError(
          `比特币发送结果不明：${firstError instanceof Error ? firstError.message : String(firstError)}；txid ${built.txid}`,
          built.txid,
        )
      }
    }
  }

  return {
    txid: built.txid,
    status: 'pending',
    feeSats: built.feeSats,
    vsize: built.vsize,
    changeSats: built.changeSats,
    inputCount: built.inputCount,
  }
}

/** 广播后最多等 3 分钟；只读状态，不影响已广播交易。 */
export async function waitForBitcoinTx(txid: string, timeoutMs = 180_000): Promise<BitcoinSendResult['status']> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await fetchTxStatus(txid).catch(() => null)
    if (status?.confirmed) return 'confirmed'
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  return 'pending'
}
