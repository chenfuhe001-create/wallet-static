import { describe, expect, it } from 'vitest'
import { isAddress } from 'viem'
import {
  AA_CHAINS,
  BSC,
  CHAINS,
  OP,
  feeCapFor,
  getAaChain,
  getAsset,
  getChain,
} from '../src/chains'

const FIXED = {
  paymaster: '0x0578cFB241215b77442a541325d6A4E6dFE700Ec',
  entrypoint: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
  implementation: '0xe6Cae83BdE06E4c305530e199D7217f42808555B',
}

describe('多链注册表', () => {
  it('登记 BSC 与全部 7 条 Circle AA 链', () => {
    expect(CHAINS.map((c) => c.id)).toEqual([56, 10, 8453, 42161, 1, 137, 43114, 130])
    expect(AA_CHAINS).toHaveLength(7)
    expect(new Set(CHAINS.map((c) => c.id)).size).toBe(CHAINS.length)
    expect(new Set(CHAINS.map((c) => c.key)).size).toBe(CHAINS.length)
  })

  it('每条 AA 链固定常量与注册表口径一致', () => {
    for (const chain of AA_CHAINS) {
      expect(chain.aa).toBe(true)
      expect(chain.paymaster).toBe(FIXED.paymaster)
      expect(chain.entrypoint).toBe(FIXED.entrypoint)
      expect(chain.implementation).toBe(FIXED.implementation)
      expect(chain.bundler).toBe(`https://public.pimlico.io/v2/${chain.id}/rpc`)
      expect(chain.explorerTx.endsWith('/tx/')).toBe(true)
      expect(chain.rpc.length).toBeGreaterThanOrEqual(2)
      expect(chain.rpc[0].url).toContain('publicnode.com')
      for (const endpoint of chain.rpc) expect(endpoint.url.startsWith('https://')).toBe(true)
      expect(isAddress(chain.feeToken.address)).toBe(true)
      expect(chain.feeToken.symbol).toBe('USDC')
      expect(chain.assets[0].address).toBe(chain.feeToken.address)
      expect(chain.assets.length).toBeGreaterThanOrEqual(1)
      for (const asset of chain.assets) {
        expect(isAddress(asset.address)).toBe(true)
        expect(asset.decimals).toBe(6)
      }
      expect(new Set(chain.assets.map((a) => a.address.toLowerCase())).size).toBe(chain.assets.length)
    }
  })

  it('手续费上限按 USDC 计且首发更高', () => {
    expect(feeCapFor(OP, false)).toBe(50_000n)
    expect(feeCapFor(OP, true)).toBe(100_000n)
    expect(feeCapFor(getAaChain(8453), false)).toBe(100_000n)
    expect(feeCapFor(getAaChain(1), false)).toBe(500_000n)
    expect(feeCapFor(getAaChain(1), true)).toBe(1_000_000n)
    for (const chain of AA_CHAINS) {
      expect(BigInt(feeCapFor(chain, true))).toBeGreaterThanOrEqual(BigInt(feeCapFor(chain, false)))
    }
  })

  it('按 chainId 取链，拒绝 BSC/未知链用于 AA', () => {
    expect(getAaChain(10)).toBe(OP)
    expect(getChain(56)).toBe(BSC)
    expect(getChain(999999)).toBeUndefined()
    expect(() => getAaChain(56)).toThrow('BSC')
    expect(() => getAaChain(999999)).toThrow('不支持')
  })

  it('资产只能从注册表取，未登记资产直接拒绝', () => {
    expect(getAsset(OP, 'USDC').address.toLowerCase()).toBe(
      '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    )
    expect(getAsset(getAaChain(8453), 'USDT').symbol).toBe('USDT')
    expect(getAsset(getAaChain(42161), 'USDT0').symbol).toBe('USDT0')
    expect(() => getAsset(getAaChain(8453), 'USDT0')).toThrow('未登记')
    expect(() => getAsset(getAaChain(10), 'DAI')).toThrow('未登记')
  })
})
