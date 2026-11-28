/**
 * 比特币单钥导出：把现有 secp256k1 私钥编码成标准 WIF（主网 + 压缩标记）。
 *
 * 同一把私钥同时控制 EVM 与 BTC；WIF 就是 EVM 私钥的另一种编码。
 * 这里只做编码，不落盘、不打印、不发网络。
 */

import { NETWORK, WIF } from '@scure/btc-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from 'viem'
import type { Hex } from 'viem'
import { btcAddressFromPrivateKey } from './address'

export interface BitcoinExportInfo {
  address: string
  /** 标准 WIF，供 Sparrow / 通用单钥导入使用。 */
  wif: string
  /** Electrum / BlueWallet 支持的脚本前缀形式。 */
  prefixedWif: string
  /** 压缩公钥，便于核对。 */
  publicKey: string
  scriptType: 'P2WPKH'
  network: 'mainnet'
}

function rawKey(privateKey: Hex): string {
  const raw = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('比特币私钥格式不正确')
  return raw.toLowerCase()
}

export function getBitcoinExport(privateKey: Hex): BitcoinExportInfo {
  const raw = rawKey(privateKey)
  const bytes = hexToBytes(`0x${raw}`)
  const wif = WIF(NETWORK).encode(bytes)
  return {
    address: btcAddressFromPrivateKey(privateKey),
    wif,
    prefixedWif: `p2wpkh:${wif}`,
    publicKey: bytesToHex(secp256k1.getPublicKey(bytes, true)),
    scriptType: 'P2WPKH',
    network: 'mainnet',
  }
}

/** 仅用于测试/核对：WIF 解码回 0x 私钥。 */
export function wifToPrivateKey(wif: string): Hex {
  try {
    const bytes = WIF(NETWORK).decode(wif.trim())
    if (bytes.length !== 32) throw new Error('长度不正确')
    return bytesToHex(bytes) as Hex
  } catch {
    throw new Error('WIF 格式不正确')
  }
}
