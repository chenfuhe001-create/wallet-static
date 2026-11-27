/** 构造/签名主网 P2WPKH 转账。 */

import * as btc from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from 'viem'
import type { Hex } from 'viem'
import { btcAddressFromPrivateKey, validateBitcoinAddress } from './address'
import { feeFor, selectUtxos } from './fees'
import type { BitcoinBuildResult, BitcoinUtxo } from './types'

export interface BuildBitcoinInput {
  privateKey: Hex
  to: string
  amountSats: bigint
  feeRate: number
  utxos: BitcoinUtxo[]
}

export function buildBitcoinTransfer(input: BuildBitcoinInput): BitcoinBuildResult {
  if (input.amountSats <= 0n) throw new Error('金额必须大于 0')
  const to = validateBitcoinAddress(input.to).address
  const raw = input.privateKey.startsWith('0x') ? input.privateKey.slice(2) : input.privateKey
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('比特币私钥格式不正确')
  const priv = hexToBytes(`0x${raw}`)
  const payment = btc.p2wpkh(secp256k1.getPublicKey(priv, true), btc.NETWORK)
  if (!payment.address || !payment.script) throw new Error('无法派生发送地址')

  const selected = selectUtxos(input.utxos, input.amountSats, input.feeRate)
  const tx = new btc.Transaction({ version: 2 })
  for (const utxo of selected.inputs) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: payment.script, amount: utxo.value },
    })
  }
  tx.addOutputAddress(to, input.amountSats, btc.NETWORK)
  if (selected.change > 0n) tx.addOutputAddress(payment.address, selected.change, btc.NETWORK)
  tx.sign(priv)
  tx.finalize()

  const fee = selected.total - input.amountSats - selected.change
  if (fee < feeFor(selected.inputs.length, selected.change > 0n ? 2 : 1, input.feeRate)) {
    throw new Error('交易手续费低于当前费率')
  }
  return {
    txid: tx.id,
    hex: tx.hex,
    status: 'broadcast',
    feeSats: fee,
    vsize: selected.vsize,
    changeSats: selected.change,
    inputCount: selected.inputs.length,
  }
}
