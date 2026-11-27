/** 主网 P2WPKH 地址派生/校验。私钥来自现有钱包，不新增保险箱字段。 */

import { p2wpkh, Address, NETWORK } from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from 'viem'
import type { Hex } from 'viem'

export const BTC_NETWORK = NETWORK

export function btcAddressFromPrivateKey(privateKey: Hex): string {
  const raw = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('比特币私钥格式不正确')
  const pub = secp256k1.getPublicKey(hexToBytes(`0x${raw}`), true)
  const payment = p2wpkh(pub, NETWORK)
  if (!payment.address) throw new Error('无法派生比特币地址')
  return payment.address
}

/** 只接受主网地址；P2PKH/P2SH/P2WPKH/P2WSH/P2TR 均可作为收款地址。 */
export function validateBitcoinAddress(value: string): { address: string; type: string } {
  const text = (value ?? '').trim()
  if (!text) throw new Error('请填写比特币地址')
  try {
    const decoded = Address(NETWORK).decode(text)
    if (!decoded || !decoded.type) throw new Error('地址格式不正确')
    return { address: text, type: String(decoded.type) }
  } catch {
    throw new Error('比特币地址格式不正确（只支持主网地址）')
  }
}
