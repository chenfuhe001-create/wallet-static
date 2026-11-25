/**
 * 批量转账编排：逐笔签名、逐笔广播，不是原子批量。
 *
 * 安全约束：
 * - 同一发送钱包严格串行；上一笔结果不明（pending）就停止该钱包后续笔，避免 nonce 冲突。
 * - 已广播的失败笔不自动重发；只有「从未广播」的失败笔允许重试。
 * - 每笔广播前做余额/手续费预检，不足直接拒绝该笔。
 */

import { isAddress } from 'viem'
import { AmbiguousBroadcastError, PreBroadcastError } from '../rpc'

export type BatchMode = 'one-to-many' | 'many-to-one'

export type BatchItemStatus =
  | 'queued'
  | 'signing'
  | 'submitting'
  | 'waiting'
  | 'success'
  | 'failed'
  | 'unknown'

export interface BatchPlanItem {
  id: string
  from: string
  to: string
  amount: string
  asset: string
  /** 重试时沿用原批次序号；新批次由执行器按顺序编号。 */
  index?: number
}

export interface BatchItem extends BatchPlanItem {
  index: number
  status: BatchItemStatus
  /** 是否已经发出过广播请求；结果不明也算已广播，禁止自动重发。 */
  broadcasted: boolean
  hash?: string
  userOpHash?: string
  fee?: string
  explorer?: string
  error?: string
}

export interface BatchSendResult {
  status: 'success' | 'failed' | 'pending'
  hash?: string
  userOpHash?: string
  fee?: string
  explorer?: string
}

export interface BatchSenderAdapter {
  address: string
  /** 同一发送钱包两笔之间的最小间隔（毫秒）。 */
  minIntervalMs: number
  /** 返回错误文案表示余额/手续费不足；返回 null 表示可以发。 */
  precheck(amount: string, to: string): Promise<string | null>
  send(to: string, amount: string): Promise<BatchSendResult>
}

export interface ParsedRecipients {
  addresses: string[]
  invalid: Array<{ line: number; value: string }>
}

export interface BatchRunOptions {
  concurrency?: number
  sleep?: (ms: number) => Promise<void>
  onUpdate?: (item: BatchItem) => void
}

const UNKNOWN_AFTER_RELOAD = '页面已关闭或刷新，结果不明；请先在区块浏览器核对，不要直接重发'

/** 手动输入 + 本地钱包勾选：去重但保持顺序，避免同一地址被转两次。 */
export function mergeRecipientAddresses(manual: string[], local: string[]): string[] {
  return Array.from(
    new Set(
      [...manual, ...local]
        .map((address) => address.trim())
        .filter(Boolean),
    ),
  )
}

/** 每行一个地址；空行与 # 注释忽略，非法地址带行号返回，不静默丢弃。 */
export function parseRecipients(text: string): ParsedRecipients {
  const addresses: string[] = []
  const invalid: Array<{ line: number; value: string }> = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim()
    if (!value || value.startsWith('#')) return
    if (isAddress(value)) addresses.push(value)
    else invalid.push({ line: index + 1, value })
  })
  return { addresses, invalid }
}

export function buildPlan(input: {
  mode: BatchMode
  senders: string[]
  recipients: string[]
  amount: string
  asset: string
}): BatchPlanItem[] {
  const senders = input.senders.map((item) => item.trim()).filter(Boolean)
  const recipients = input.recipients.map((item) => item.trim()).filter(Boolean)
  if (!senders.length) throw new Error('请选择发送钱包')
  if (!recipients.length) throw new Error('请填写收款地址')
  const amount = input.amount.trim()
  if (!amount || !(Number(amount) > 0)) throw new Error('金额必须大于 0')

  const pairs: Array<[string, string]> =
    input.mode === 'one-to-many'
      ? recipients.map((to) => [senders[0], to])
      : senders.map((from) => [from, recipients[0]])

  return pairs.map(([from, to], index) => ({
    id: `item-${index + 1}`,
    from,
    to,
    amount,
    asset: input.asset,
  }))
}

export function isRetryable(item: BatchItem): boolean {
  return item.status === 'failed' && !item.broadcasted
}

/**
 * 执行批次：不同发送钱包并发（默认最多 3 个），同一钱包内严格串行；
 * 每笔之间按适配器的 minIntervalMs 节流。返回最终状态（原地更新）。
 */
export async function runBatch(
  plan: BatchPlanItem[],
  adapters: Map<string, BatchSenderAdapter>,
  options: BatchRunOptions = {},
): Promise<BatchItem[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 10))
  const items: BatchItem[] = plan.map((item, index) => ({
    ...item,
    index: item.index ?? index + 1,
    status: 'queued',
    broadcasted: false,
  }))

  const groups = new Map<string, BatchItem[]>()
  for (const item of items) {
    const group = groups.get(item.from)
    if (group) group.push(item)
    else groups.set(item.from, [item])
  }

  const update = (item: BatchItem, patch: Partial<BatchItem>) => {
    Object.assign(item, patch)
    options.onUpdate?.(item)
  }

  const queue = [...groups.values()]
  const worker = async () => {
    while (queue.length) {
      const group = queue.shift()
      if (!group) return
      const adapter = adapters.get(group[0].from)
      let blocked = ''

      for (let i = 0; i < group.length; i += 1) {
        const item = group[i]
        if (blocked) {
          // 从未广播：属于可重试的失败项；但必须先处理上一笔结果不明的 nonce。
          update(item, { status: 'failed', broadcasted: false, error: `${blocked}；该笔未广播` })
          continue
        }
        if (!adapter) {
          update(item, { status: 'failed', error: '缺少发送钱包适配器，未广播' })
          continue
        }

        update(item, { status: 'signing' })
        let precheckError: string | null = null
        try {
          precheckError = await adapter.precheck(item.amount, item.to)
        } catch (err) {
          precheckError = err instanceof Error ? err.message : '余额预检失败'
        }
        if (precheckError) {
          update(item, { status: 'failed', error: precheckError, broadcasted: false })
          continue
        }

        update(item, { status: 'submitting' })
        try {
          const result = await adapter.send(item.to, item.amount)
          if (result.status === 'success') {
            update(item, {
              status: 'success',
              broadcasted: true,
              hash: result.hash,
              userOpHash: result.userOpHash,
              fee: result.fee,
              explorer: result.explorer,
            })
          } else if (result.status === 'failed') {
            update(item, {
              status: 'failed',
              broadcasted: true,
              hash: result.hash,
              userOpHash: result.userOpHash,
              fee: result.fee,
              explorer: result.explorer,
              error: '交易已上链但执行失败，金额未转出；请先核对哈希',
            })
          } else {
            update(item, {
              status: 'unknown',
              broadcasted: true,
              hash: result.hash,
              userOpHash: result.userOpHash,
              explorer: result.explorer,
              error: '结果不明：等待回执超时，请先在区块浏览器核对',
            })
            blocked = '上一笔结果不明'
          }
        } catch (err) {
          if (err instanceof PreBroadcastError) {
            // 读 RPC/估算/签名阶段失败：交易肯定没发出，可以安全重试。
            update(item, { status: 'failed', broadcasted: false, error: err.message })
            continue
          }
          if (err instanceof AmbiguousBroadcastError) {
            // 广播响应丢失：保留 userOpHash/交易哈希，供后续按哈希核对。
            update(item, {
              status: 'unknown',
              broadcasted: true,
              hash: err.txHash,
              userOpHash: err.userOpHash,
              error: err.message,
            })
            blocked = '上一笔发送结果不明'
            continue
          }
          // 广播调用抛错时无法判断请求是否已到 bundler/RPC：按“结果不明”处理，
          // 不自动重发；并停止该钱包后续笔，避免 nonce 冲突。
          update(item, {
            status: 'unknown',
            broadcasted: true,
            error: `发送结果不明：${err instanceof Error ? err.message : '发送失败'}；请先在区块浏览器核对`,
          })
          blocked = '上一笔发送结果不明'
        }

        if (i < group.length - 1) await sleep(adapter.minIntervalMs)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()))
  return items
}

/** 页面重开后恢复：未完成的签名/提交/等待笔标为 unknown，绝不假装成功。 */
export function recoverBatch(items: BatchItem[]): BatchItem[] {
  return items.map((item) => {
    if (['queued', 'success', 'failed', 'unknown'].includes(item.status)) return item
    return {
      ...item,
      status: 'unknown' as const,
      broadcasted: true,
      error: UNKNOWN_AFTER_RELOAD,
    }
  })
}
