/** 批量批次本地快照：只存地址/金额/状态/哈希，绝不存私钥或密码。 */

import type { BatchItem } from './evm/batch'

const VERSION = 1
const PREFIX = 'wallet-static-batch'

export interface StoredBatch {
  version: number
  chainId: number
  asset: string
  updatedAt: number
  items: BatchItem[]
}

function keyFor(chainId: number): string {
  return `${PREFIX}:${chainId}`
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadBatch(chainId: number): StoredBatch | null {
  const raw = storage()?.getItem(keyFor(chainId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredBatch
    if (parsed.version !== VERSION || !Array.isArray(parsed.items) || parsed.chainId !== chainId) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function saveBatch(chainId: number, asset: string, items: BatchItem[]): void {
  storage()?.setItem(
    keyFor(chainId),
    JSON.stringify({ version: VERSION, chainId, asset, updatedAt: Date.now(), items } satisfies StoredBatch),
  )
}

export function clearBatch(chainId: number): void {
  storage()?.removeItem(keyFor(chainId))
}
