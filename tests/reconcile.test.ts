import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, keccak256, pad, stringToHex, type Hex } from 'viem'
import { decodeTransferLogs, reconcileFromLogs } from '../src/evm/reconcile'
import type { BatchItem } from '../src/evm/batch'

const TOKEN = { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' as const, decimals: 6 }
const TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const FROM_A = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const FROM_B = '0x000000000000000000000000000000000000dEaD'
const TO = '0x1111111111111111111111111111111111111111'
const TX = `0x${'ab'.repeat(32)}` as Hex
const BLOCK = '0x1234'

function transferLog(from: string, to: string, amount: bigint) {
  return {
    address: TOKEN.address,
    topics: [TOPIC, pad(from as Hex, { size: 32 }), pad(to as Hex, { size: 32 })],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
    transactionHash: TX,
    blockNumber: BLOCK,
  }
}

function item(overrides: Partial<BatchItem>): BatchItem {
  return {
    id: 'item-1',
    index: 1,
    from: FROM_A,
    to: TO,
    amount: '0.005',
    asset: 'USDC',
    status: 'unknown',
    broadcasted: true,
    ...overrides,
  }
}

describe('链上转账核对', () => {
  it('解码 Transfer 日志并忽略非 Transfer', () => {
    const logs = [
      transferLog(FROM_A, TO, 5_000n),
      { ...transferLog(FROM_B, TO, 1n), topics: [`0x${'00'.repeat(32)}`, pad(FROM_B as Hex, { size: 32 }), pad(TO as Hex, { size: 32 })] },
    ]
    const decoded = decodeTransferLogs(logs)
    expect(decoded).toHaveLength(1)
    expect(decoded[0].from.toLowerCase()).toBe(FROM_A.toLowerCase())
    expect(decoded[0].to.toLowerCase()).toBe(TO.toLowerCase())
    expect(decoded[0].amount).toBe(5_000n)
    expect(decoded[0].txHash).toBe(TX)
  })

  it('找到匹配转账则成功，找不到则标失败', () => {
    const outcomes = reconcileFromLogs(
      [
        item({ id: 'a', from: FROM_A }),
        item({ id: 'b', from: FROM_B }),
        item({ id: 'c', from: FROM_A, status: 'success' }),
      ],
      TOKEN,
      decodeTransferLogs([transferLog(FROM_A, TO, 5_000n)]),
    )
    expect(outcomes.map((outcome) => [outcome.id, outcome.status])).toEqual([
      ['a', 'success'],
      ['b', 'failed'],
    ])
    expect(outcomes[0].hash).toBe(TX)
    expect(outcomes[0].amount).toBe('0.005')
    expect(outcomes[1].note).toContain('未找到')
  })

  it('金额不足的转账不算成功', () => {
    const outcomes = reconcileFromLogs(
      [item({ from: FROM_A, amount: '0.01' })],
      TOKEN,
      decodeTransferLogs([transferLog(FROM_A, TO, 5_000n)]),
    )
    expect(outcomes[0].status).toBe('failed')
  })

  it('只核对结果不明/未广播失败项，已成功的项不重复处理', () => {
    const outcomes = reconcileFromLogs(
      [
        item({ id: 'unknown', status: 'unknown' }),
        item({ id: 'failed-retry', status: 'failed', broadcasted: false }),
        item({ id: 'failed-mined', status: 'failed', broadcasted: true, hash: TX }),
        item({ id: 'success', status: 'success' }),
      ],
      TOKEN,
      [],
    )
    expect(outcomes.map((outcome) => outcome.id)).toEqual(['unknown', 'failed-retry'])
  })
})
