/**
 * 纯本机偏好：默认链 key 只存 localStorage，不涉及密码/私钥。
 * 默认以太坊 AA；用户切换链后自动记住，下次打开直接进入该链。
 */

import { getChain } from './chains'

export const DEFAULT_CHAIN_KEY = 'ethereum'
export const DEFAULT_CHAIN_STORAGE_KEY = 'wallet-static.default-chain-key'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 只接受注册表里存在的链 key；空值/旧配置/损坏值一律回到以太坊 AA。 */
export function normalizeDefaultChainKey(value: string | null | undefined): string {
  const key = (value ?? '').trim()
  return key && getChain(key) ? key : DEFAULT_CHAIN_KEY
}

export function loadDefaultChainKey(storage?: StorageLike | null): string {
  const target = resolveStorage(storage)
  if (!target) return DEFAULT_CHAIN_KEY
  try {
    return normalizeDefaultChainKey(target.getItem(DEFAULT_CHAIN_STORAGE_KEY))
  } catch {
    return DEFAULT_CHAIN_KEY
  }
}

export function saveDefaultChainKey(key: string, storage?: StorageLike | null): string {
  const normalized = normalizeDefaultChainKey(key)
  const target = resolveStorage(storage)
  if (!target) return normalized
  try {
    target.setItem(DEFAULT_CHAIN_STORAGE_KEY, normalized)
  } catch {
    /* 隐私模式/配额满时忽略，不影响当前会话 */
  }
  return normalized
}
