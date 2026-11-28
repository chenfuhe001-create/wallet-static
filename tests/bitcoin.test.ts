import { afterEach, describe, expect, it, vi } from 'vitest'
import { btcAddressFromPrivateKey, validateBitcoinAddress } from '../src/bitcoin/address'
import { getBitcoinExport, wifToPrivateKey } from '../src/bitcoin/export'
import { estimateVsize, feeFor, feeRatesFromEstimates, selectUtxos } from '../src/bitcoin/fees'
import { buildBitcoinTransfer } from '../src/bitcoin/tx'
import { BitcoinAmbiguousError, sendBitcoin } from '../src/bitcoin/send'
import type { BitcoinUtxo } from '../src/bitcoin/types'

const KEY1 = `0x${'00'.repeat(31)}01` as const
const KEY2 = `0x${'00'.repeat(31)}02` as const
const TXID = '11'.repeat(32)
const UTXO: BitcoinUtxo = { txid: TXID, vout: 0, value: 100_000n, confirmed: true }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('比特币地址与费率', () => {
  it('私钥 1 派生已知 BIP173 P2WPKH 地址', () => {
    expect(btcAddressFromPrivateKey(KEY1)).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
  })

  it('接受主网地址，拒绝测试网/非法地址', () => {
    expect(validateBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').type).toBe('wpkh')
    expect(validateBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').type).toBe('pkh')
    expect(() => validateBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toThrow('主网')
    expect(() => validateBitcoinAddress('not-an-address')).toThrow('比特币地址')
  })

  it('按目标区块映射快/正常/慢费率', () => {
    expect(feeRatesFromEstimates({ '1': 8.2, '3': 4.1, '144': 1.2 })).toEqual({
      fast: 9,
      normal: 5,
      slow: 2,
    })
    expect(feeRatesFromEstimates({})).toEqual({ fast: 1, normal: 1, slow: 1 })
  })
})

describe('比特币单钥导出', () => {
  it('私钥 1 的压缩 WIF 与 P2WPKH 地址符合已知向量', () => {
    const info = getBitcoinExport(KEY1)
    expect(info.wif).toBe('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn')
    expect(info.prefixedWif).toBe(`p2wpkh:${info.wif}`)
    expect(info.address).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    expect(info.scriptType).toBe('P2WPKH')
    expect(info.network).toBe('mainnet')
  })

  it('WIF 解码后仍是同一私钥和地址', () => {
    const info = getBitcoinExport(KEY2)
    const raw = wifToPrivateKey(info.wif)
    expect(raw).toBe(KEY2)
    expect(btcAddressFromPrivateKey(raw)).toBe(info.address)
  })

  it('非法私钥直接拒绝', () => {
    expect(() => getBitcoinExport('0x1234' as never)).toThrow('比特币私钥')
    expect(() => wifToPrivateKey('not-a-wif')).toThrow('WIF')
  })
})

describe('UTXO 选择与手续费', () => {
  it('P2WPKH vsize 与手续费向上取整', () => {
    expect(estimateVsize(1, 2)).toBe(141)
    expect(feeFor(1, 2, 2)).toBe(282n)
  })

  it('优先最大 UTXO，找零低于粉尘并入手续费', () => {
    const selected = selectUtxos([UTXO], 60_000n, 2)
    expect(selected.inputs).toHaveLength(1)
    expect(selected.fee).toBe(282n)
    expect(selected.change).toBe(39_718n)

    const dust = selectUtxos([UTXO], 99_600n, 2)
    expect(dust.change).toBe(0n)
    expect(dust.fee).toBe(400n)

    expect(() => selectUtxos([UTXO], 99_900n, 2)).toThrow('余额不足')
    expect(() => selectUtxos([{ ...UTXO, confirmed: false }], 1_000n, 2)).toThrow('已确认')
  })
})

describe('比特币交易构造', () => {
  it('生成可签名的 P2WPKH 交易与 txid', () => {
    const built = buildBitcoinTransfer({
      privateKey: KEY1,
      to: btcAddressFromPrivateKey(KEY2),
      amountSats: 50_000n,
      feeRate: 2,
      utxos: [UTXO],
    })
    expect(built.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(built.feeSats).toBe(282n)
    expect(built.changeSats).toBe(49_718n)
    expect(built.hex.length).toBeGreaterThan(100)
  })
})

describe('比特币广播恢复', () => {
  function mockFetch(options: { failPosts: number; statusFound: boolean }) {
    let posts = 0
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/utxo')) {
          return new Response(
            JSON.stringify([
              { txid: TXID, vout: 0, value: 100_000, status: { confirmed: true } },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/status')) {
          return new Response('{}', { status: options.statusFound ? 200 : 404 })
        }
        if (url.endsWith('/tx') && init?.method === 'POST') {
          posts += 1
          bodies.push(String(init.body))
          if (posts <= options.failPosts) throw new TypeError('Failed to fetch')
          return new Response('5a2908581a15c8b1143ca95bc0d24d13980e703d3b3e9d2464399be7edcd9ac9', {
            status: 200,
          })
        }
        return new Response('unexpected', { status: 500 })
      }),
    )
    return { posts: () => posts, bodies }
  }

  it('广播响应丢失时按 txid 查询，不重新构造交易', async () => {
    const mock = mockFetch({ failPosts: 2, statusFound: true })
    const result = await sendBitcoin({
      privateKey: KEY1,
      to: btcAddressFromPrivateKey(KEY2),
      amountSats: 50_000n,
      feeRate: 2,
    })
    expect(result.status).toBe('pending')
    // 两个 API 端点各尝试一次，但都是同一份 raw tx
    expect(mock.posts()).toBe(2)
    expect(new Set(mock.bodies).size).toBe(1)
  })

  it('查不到 txid 时用同一份 raw tx 重播一次', async () => {
    const mock = mockFetch({ failPosts: 2, statusFound: false })
    const result = await sendBitcoin({
      privateKey: KEY1,
      to: btcAddressFromPrivateKey(KEY2),
      amountSats: 50_000n,
      feeRate: 2,
    })
    expect(result.status).toBe('pending')
    expect(mock.posts()).toBe(3)
    expect(new Set(mock.bodies).size).toBe(1)
  })

  it('两次广播都失败时保留 txid，标记结果不明', async () => {
    const mock = mockFetch({ failPosts: 99, statusFound: false })
    await expect(
      sendBitcoin({
        privateKey: KEY1,
        to: btcAddressFromPrivateKey(KEY2),
        amountSats: 50_000n,
        feeRate: 2,
      }),
    ).rejects.toBeInstanceOf(BitcoinAmbiguousError)
    expect(mock.posts()).toBe(4)
  })
})
