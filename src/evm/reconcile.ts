/**
 * 结果不明项的链上核对：
 * - 有 UserOp 哈希：直接查 Pimlico 回执；
 * - 无哈希（旧记录/响应丢失）：查 ERC-20 Transfer 日志，按 from/to/金额匹配。
 *
 * 只读，不广播；核对结果由用户确认后再决定是否重试。
 */

import {
  decodeAbiParameters,
  formatUnits,
  keccak256,
  numberToHex,
  pad,
  parseUnits,
  stringToHex,
  type Hex,
} from 'viem'
import { getAsset } from '../chains'
import type { AaChainConfig, TokenAsset } from '../chains'
import { rpcRead } from '../rpc'
import type { RpcBatchItem } from '../rpc'
import { bundlerBatch } from './bundler'
import { PacerBusyError } from './limiter'
import type { BatchItem } from './batch'
import { parseUserOpReceipt } from './op'
import type { UserOpReceiptRaw } from './op'

const TRANSFER_TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))

export interface RawLog {
  address?: string
  topics?: string[]
  data?: Hex
  transactionHash?: Hex
  blockNumber?: string
}

export interface TransferLog {
  from: string
  to: string
  amount: bigint
  txHash: Hex
  blockNumber: bigint
}

export interface ReconcileOutcome {
  id: string
  status: 'success' | 'failed' | 'unknown'
  hash?: string
  amount?: string
  note: string
}

function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40)}`
}

export function decodeTransferLogs(logs: RawLog[]): TransferLog[] {
  const out: TransferLog[] = []
  for (const log of logs) {
    try {
      if (!log.topics || log.topics.length < 3) continue
      if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue
      const [amount] = decodeAbiParameters([{ type: 'uint256' }], (log.data || '0x') as Hex)
      out.push({
        from: addressFromTopic(log.topics[1]),
        to: addressFromTopic(log.topics[2]),
        amount: amount as bigint,
        txHash: (log.transactionHash || '0x') as Hex,
        blockNumber: BigInt(log.blockNumber || '0x0'),
      })
    } catch {
      /* 非标准日志忽略 */
    }
  }
  return out
}

function targetsFor(items: BatchItem[]): BatchItem[] {
  return items.filter(
    (item) => item.status === 'unknown' || (item.status === 'failed' && !item.broadcasted),
  )
}

/** 纯函数：按 from/to/金额匹配链上 Transfer 日志。 */
export function reconcileFromLogs(
  items: BatchItem[],
  token: TokenAsset,
  logs: TransferLog[],
): ReconcileOutcome[] {
  const outcomes: ReconcileOutcome[] = []
  for (const item of targetsFor(items)) {
    if (item.asset.toUpperCase() !== token.symbol.toUpperCase()) continue
    const wanted = parseUnits(item.amount, token.decimals)
    const match = logs.find(
      (log) =>
        log.from.toLowerCase() === item.from.toLowerCase() &&
        log.to.toLowerCase() === item.to.toLowerCase() &&
        log.amount === wanted,
    )
    if (match) {
      outcomes.push({
        id: item.id,
        status: 'success',
        hash: match.txHash,
        amount: formatUnits(match.amount, token.decimals),
        note: '链上找到对应转账',
      })
    } else {
      outcomes.push({
        id: item.id,
        status: 'failed',
        note: '链上未找到该转账；确认未广播后可重试',
      })
    }
  }
  return outcomes
}

async function getTransferLogs(
  chain: AaChainConfig,
  token: string,
  to: string,
  latest: bigint,
): Promise<RawLog[]> {
  const topics = [TRANSFER_TOPIC, null, pad(to as Hex, { size: 32 })]
  const query = (fromBlock: bigint) =>
    rpcRead<RawLog[]>(
      chain.rpc,
      'eth_getLogs',
      [{ address: token, fromBlock: numberToHex(fromBlock), toBlock: 'latest', topics }],
      30_000,
    )
  const wide = latest > 5_000n ? latest - 5_000n : 0n
  try {
    return await query(wide)
  } catch {
    // 公共 RPC 可能限制日志区间，退回最近 1000 块。
    return await query(latest > 1_000n ? latest - 1_000n : 0n)
  }
}

/** 对 AA 链的 ERC-20 项按 Transfer 日志核对（适合没有 UserOp 哈希的旧记录）。 */
export async function reconcileErc20Batch(
  chain: AaChainConfig,
  items: BatchItem[],
): Promise<ReconcileOutcome[]> {
  const targets = targetsFor(items)
  if (!targets.length) return []
  const latest = BigInt(await rpcRead<Hex>(chain.rpc, 'eth_blockNumber', []))
  const groups = new Map<string, { token: TokenAsset; items: BatchItem[] }>()
  for (const item of targets) {
    let token: TokenAsset
    try {
      token = getAsset(chain, item.asset)
    } catch {
      continue
    }
    const key = `${token.address.toLowerCase()}:${item.to.toLowerCase()}`
    const group = groups.get(key) ?? { token, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }

  const outcomes: ReconcileOutcome[] = []
  for (const group of groups.values()) {
    const raw = await getTransferLogs(chain, group.token.address, group.items[0].to, latest)
    outcomes.push(...reconcileFromLogs(group.items, group.token, decodeTransferLogs(raw)))
  }
  return outcomes
}

/**
 * 有 UserOp 哈希的项：一次 JSON-RPC 批量查回执，避免每笔都打一次 bundler。
 * 暂无回执不判失败；bundler 冷却时保持「不明」，等冷却后再点核对。
 */
export async function reconcileUserOps(
  chain: AaChainConfig,
  items: BatchItem[],
): Promise<ReconcileOutcome[]> {
  const targets = items.filter(
    (item): item is BatchItem & { userOpHash: string } =>
      item.status === 'unknown' && Boolean(item.userOpHash),
  )
  if (!targets.length) return []

  let batch: Map<number, RpcBatchItem<UserOpReceiptRaw | null>>
  try {
    batch = await bundlerBatch<UserOpReceiptRaw | null>(
      chain,
      targets.map((item, index) => ({
        id: index,
        method: 'eth_getUserOperationReceipt',
        params: [item.userOpHash],
      })),
      30_000,
      20_000,
    )
  } catch (err) {
    const note =
      err instanceof PacerBusyError
        ? 'bundler 正在冷却，请等倒计时结束再核对'
        : `bundler 查询失败：${err instanceof Error ? err.message : String(err)}`
    return targets.map((item) => ({ id: item.id, status: 'unknown' as const, note }))
  }

  const outcomes: ReconcileOutcome[] = []
  for (let index = 0; index < targets.length; index += 1) {
    const item = targets[index]
    const response = batch.get(index)
    if (!response || response.error || !response.result) {
      outcomes.push({
        id: item.id,
        status: 'unknown',
        note: response?.error?.message
          ? `回执查询失败：${response.error.message}`
          : '暂无 UserOp 回执，可能仍在打包',
      })
      continue
    }
    const receipt = parseUserOpReceipt(chain, item.userOpHash as Hex, response.result)
    outcomes.push({
      id: item.id,
      status: receipt.status === 'success' ? 'success' : 'failed',
      hash: receipt.txHash,
      amount: receipt.feeUsdc,
      note: '按 UserOp 回执核对',
    })
  }
  return outcomes
}
