import { describe, expect, it } from 'vitest'
import {
  buildPlan,
  isRetryable,
  parseRecipients,
  recoverBatch,
  runBatch,
} from '../src/evm/batch'
import type { BatchItem, BatchSenderAdapter, BatchSendResult } from '../src/evm/batch'
import { PreBroadcastError } from '../src/rpc'

const FROM_A = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const FROM_B = '0x000000000000000000000000000000000000dEaD'
const TO_1 = '0x1111111111111111111111111111111111111111'
const TO_2 = '0x2222222222222222222222222222222222222222'
const TO_3 = '0x3333333333333333333333333333333333333333'

interface FakeAdapter extends BatchSenderAdapter {
  calls: Array<{ to: string; amount: string }>
}

function fakeAdapter(
  address: string,
  behavior: (to: string, amount: string, call: number) => Promise<BatchSendResult>,
  options: { precheck?: (amount: string) => Promise<string | null>; interval?: number } = {},
): FakeAdapter {
  const calls: Array<{ to: string; amount: string }> = []
  return {
    address,
    minIntervalMs: options.interval ?? 1000,
    calls,
    precheck: options.precheck ?? (async () => null),
    async send(to, amount) {
      calls.push({ to, amount })
      return behavior(to, amount, calls.length)
    },
  }
}

function planOf(pairs: Array<[string, string]>): ReturnType<typeof buildPlan> {
  return pairs.map(([from, to], index) => ({
    id: `item-${index + 1}`,
    from,
    to,
    amount: '0.01',
    asset: 'USDC',
  }))
}

describe('批量转账：输入解析', () => {
  it('每行一个地址，忽略空行/注释并保留顺序', () => {
    const parsed = parseRecipients(`\n${TO_1}\n  ${TO_2}  \n# 注释\n${TO_1}\n`)
    expect(parsed.addresses).toEqual([TO_1, TO_2, TO_1])
    expect(parsed.invalid).toEqual([])
  })

  it('报告非法地址的行号，不静默丢弃', () => {
    const parsed = parseRecipients(`${TO_1}\n0x1234\n0xZZZZ\n`)
    expect(parsed.addresses).toEqual([TO_1])
    expect(parsed.invalid).toEqual([
      { line: 2, value: '0x1234' },
      { line: 3, value: '0xZZZZ' },
    ])
  })

  it('一个→多个：单个发送钱包 × 全部地址', () => {
    const plan = buildPlan({
      mode: 'one-to-many',
      senders: [FROM_A],
      recipients: [TO_1, TO_2],
      amount: '0.01',
      asset: 'USDC',
    })
    expect(plan.map((item) => [item.from, item.to])).toEqual([
      [FROM_A, TO_1],
      [FROM_A, TO_2],
    ])
  })

  it('多个→一个：全部发送钱包 × 单个地址', () => {
    const plan = buildPlan({
      mode: 'many-to-one',
      senders: [FROM_A, FROM_B],
      recipients: [TO_1],
      amount: '0.01',
      asset: 'USDC',
    })
    expect(plan.map((item) => [item.from, item.to])).toEqual([
      [FROM_A, TO_1],
      [FROM_B, TO_1],
    ])
  })

  it('缺少发送方/收款方/金额时拒绝建批次', () => {
    expect(() =>
      buildPlan({ mode: 'one-to-many', senders: [], recipients: [TO_1], amount: '1', asset: 'USDC' }),
    ).toThrow('发送钱包')
    expect(() =>
      buildPlan({ mode: 'one-to-many', senders: [FROM_A], recipients: [], amount: '1', asset: 'USDC' }),
    ).toThrow('收款地址')
    expect(() =>
      buildPlan({ mode: 'one-to-many', senders: [FROM_A], recipients: [TO_1], amount: '0', asset: 'USDC' }),
    ).toThrow('金额')
  })
})

describe('批量转账：执行器', () => {
  it('同一发送钱包串行、不同钱包并发不超过 3', async () => {
    const senders = [FROM_A, FROM_B, TO_1, TO_2]
    let active = 0
    let maxActive = 0
    const perSenderActive = new Map<string, number>()
    let maxPerSender = 0
    const adapters = new Map(
      senders.map((address) => [
        address,
        fakeAdapter(address, async () => {
          active += 1
          const current = (perSenderActive.get(address) ?? 0) + 1
          perSenderActive.set(address, current)
          maxActive = Math.max(maxActive, active)
          maxPerSender = Math.max(maxPerSender, current)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          perSenderActive.set(address, current - 1)
          return { status: 'success' as const, hash: `0x${'ab'.repeat(32)}` }
        }),
      ]),
    )
    const plan = planOf(
      senders.flatMap((from) =>
        [TO_3, TO_1].map((to) => [from, to] as [string, string]),
      ),
    )
    const items = await runBatch(plan, adapters, { concurrency: 3, sleep: async () => {} })
    expect(items.every((item) => item.status === 'success' && item.broadcasted)).toBe(true)
    expect(maxPerSender).toBe(1)
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(maxActive).toBeGreaterThanOrEqual(2)
  })

  it('逐笔记录哈希与状态，链上执行失败不影响其他笔', async () => {
    const adapter = fakeAdapter(FROM_A, async (to) => {
      if (to === TO_2) {
        return { status: 'failed', hash: `0x${'12'.repeat(32)}`, explorer: 'https://scan/tx/0x12' }
      }
      return { status: 'success', hash: `0x${'cd'.repeat(32)}`, fee: '0.0001' }
    })
    const items = await runBatch(
      planOf([
        [FROM_A, TO_1],
        [FROM_A, TO_2],
        [FROM_A, TO_3],
      ]),
      new Map([[FROM_A, adapter]]),
      { sleep: async () => {} },
    )
    expect(items.map((item) => item.status)).toEqual(['success', 'failed', 'success'])
    expect(items[0].hash).toBe(`0x${'cd'.repeat(32)}`)
    expect(items[1].broadcasted).toBe(true)
    expect(items[1].hash).toBe(`0x${'12'.repeat(32)}`)
    expect(items[1].error).toContain('上链')
    expect(isRetryable(items[1])).toBe(false)
  })

  it('广播前的网络失败标为失败且可重试，不阻塞后续笔', async () => {
    const adapter = fakeAdapter(FROM_A, async (to) => {
      if (to === TO_2) throw new PreBroadcastError('BSC 发送前失败：Failed to fetch')
      return { status: 'success', hash: `0x${'56'.repeat(32)}` }
    })
    const items = await runBatch(
      planOf([
        [FROM_A, TO_1],
        [FROM_A, TO_2],
        [FROM_A, TO_3],
      ]),
      new Map([[FROM_A, adapter]]),
      { sleep: async () => {} },
    )
    expect(items.map((item) => item.status)).toEqual(['success', 'failed', 'success'])
    expect(items[1].broadcasted).toBe(false)
    expect(items[1].error).toContain('Failed to fetch')
    expect(isRetryable(items[1])).toBe(true)
    expect(adapter.calls).toHaveLength(3)
  })

  it('发送抛错按结果不明处理，停止该钱包后续笔', async () => {
    const adapter = fakeAdapter(FROM_A, async (to) => {
      if (to === TO_2) throw new Error('网络超时')
      return { status: 'success', hash: `0x${'34'.repeat(32)}` }
    })
    const items = await runBatch(
      planOf([
        [FROM_A, TO_1],
        [FROM_A, TO_2],
        [FROM_A, TO_3],
      ]),
      new Map([[FROM_A, adapter]]),
      { sleep: async () => {} },
    )
    expect(items.map((item) => item.status)).toEqual(['success', 'unknown', 'failed'])
    expect(items[1].broadcasted).toBe(true)
    expect(items[2].broadcasted).toBe(false)
    expect(items[2].error).toContain('未广播')
    expect(adapter.calls).toHaveLength(2)
    expect(isRetryable(items[1])).toBe(false)
    expect(isRetryable(items[2])).toBe(true)
  })

  it('余额预检失败直接拒绝该笔，不广播', async () => {
    const adapter = fakeAdapter(
      FROM_A,
      async () => ({ status: 'success', hash: `0x${'ef'.repeat(32)}` }),
      {
        precheck: async (amount) => (amount === '0.01' ? 'USDC 余额不足' : null),
        interval: 0,
      },
    )
    const plan = planOf([
      [FROM_A, TO_1],
      [FROM_A, TO_2],
    ])
    plan[1].amount = '0.02'
    const items = await runBatch(plan, new Map([[FROM_A, adapter]]), { sleep: async () => {} })
    expect(items[0].status).toBe('failed')
    expect(items[0].broadcasted).toBe(false)
    expect(items[0].error).toContain('余额不足')
    expect(items[1].status).toBe('success')
    expect(adapter.calls).toHaveLength(1)
  })

  it('结果不明（pending）后停止该发送钱包，剩余笔标记失败且未广播、可重试', async () => {
    const adapter = fakeAdapter(FROM_A, async () => ({
      status: 'pending',
      hash: `0x${'aa'.repeat(32)}`,
    }))
    const items = await runBatch(
      planOf([
        [FROM_A, TO_1],
        [FROM_A, TO_2],
      ]),
      new Map([[FROM_A, adapter]]),
      { sleep: async () => {} },
    )
    expect(items[0].status).toBe('unknown')
    expect(items[0].broadcasted).toBe(true)
    expect(items[1].status).toBe('failed')
    expect(items[1].broadcasted).toBe(false)
    expect(items[1].error).toContain('未广播')
    expect(adapter.calls).toHaveLength(1)
    expect(isRetryable(items[1])).toBe(true)
  })

  it('同一发送钱包两笔之间按链节流等待', async () => {
    const sleeps: number[] = []
    const adapter = fakeAdapter(
      FROM_A,
      async () => ({ status: 'success', hash: `0x${'bb'.repeat(32)}` }),
      { interval: 1500 },
    )
    await runBatch(
      planOf([
        [FROM_A, TO_1],
        [FROM_A, TO_2],
      ]),
      new Map([[FROM_A, adapter]]),
      { sleep: async (ms) => void sleeps.push(ms) },
    )
    expect(sleeps).toEqual([1500])
  })

  it('只允许重试从未广播的失败项', () => {
    const base = { id: '1', index: 1, from: FROM_A, to: TO_1, amount: '1', asset: 'USDC' }
    expect(isRetryable({ ...base, status: 'failed', broadcasted: false } as BatchItem)).toBe(true)
    expect(isRetryable({ ...base, status: 'failed', broadcasted: true } as BatchItem)).toBe(false)
    expect(isRetryable({ ...base, status: 'unknown', broadcasted: false } as BatchItem)).toBe(false)
    expect(isRetryable({ ...base, status: 'success', broadcasted: true } as BatchItem)).toBe(false)
  })
})

describe('批量转账：页面重开恢复', () => {
  it('未开始的排队项保留；签名/提交/等待回执项标为结果不明且不可自动重发', () => {
    const base = { from: FROM_A, to: TO_1, amount: '1', asset: 'USDC', index: 1 }
    const recovered = recoverBatch([
      { ...base, id: 'a', status: 'queued', broadcasted: false },
      { ...base, id: 'b', status: 'signing', broadcasted: false },
      { ...base, id: 'c', status: 'submitting', broadcasted: true },
      { ...base, id: 'd', status: 'waiting', broadcasted: true },
      { ...base, id: 'e', status: 'success', broadcasted: true, hash: `0x${'01'.repeat(32)}` },
    ] as BatchItem[])
    expect(recovered.map((item) => item.status)).toEqual([
      'queued',
      'unknown',
      'unknown',
      'unknown',
      'success',
    ])
    expect(recovered[1].error).toContain('页面已关闭')
    expect(recovered[1].broadcasted).toBe(true)
    expect(isRetryable(recovered[1])).toBe(false)
    expect(recovered[0].broadcasted).toBe(false)
  })
})
