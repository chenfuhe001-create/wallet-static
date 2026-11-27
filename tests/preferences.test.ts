import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAIN_KEY,
  loadDefaultChainKey,
  normalizeDefaultChainKey,
  saveDefaultChainKey,
} from '../src/preferences'

type MiniStorage = Pick<Storage, 'getItem' | 'setItem'>

function memoryStorage(initial: Record<string, string> = {}): MiniStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

describe('本地默认链配置', () => {
  it('没有本地配置时默认以太坊 AA', () => {
    expect(DEFAULT_CHAIN_KEY).toBe('ethereum')
    expect(normalizeDefaultChainKey(null)).toBe('ethereum')
    expect(normalizeDefaultChainKey('not-a-chain')).toBe('ethereum')
    expect(loadDefaultChainKey(null)).toBe('ethereum')
  })

  it('保留合法的链 key', () => {
    expect(normalizeDefaultChainKey('bsc')).toBe('bsc')
    expect(normalizeDefaultChainKey('optimism')).toBe('optimism')
    expect(normalizeDefaultChainKey('ethereum-native')).toBe('ethereum-native')
    expect(normalizeDefaultChainKey('bitcoin')).toBe('bitcoin')
  })

  it('读取和保存都落在本机存储', () => {
    const storage = memoryStorage()
    expect(loadDefaultChainKey(storage)).toBe('ethereum')
    saveDefaultChainKey('base', storage)
    expect(storage.data.get('wallet-static.default-chain-key')).toBe('base')
    expect(loadDefaultChainKey(storage)).toBe('base')
  })
})
