/**
 * Pimlico bundler 客户端：全局串行 + 滑动窗口限速 + 限流冷却。
 *
 * 公共 `public.pimlico.io` 按 IP 限流（文档 20 次/分钟，实测更容易触发 WAF）。
 * 钱包批量转账时，gas 查询、估算、广播、回执都会打 bundler；如果每笔都查一遍，
 * 9 笔就能把配额打满，而且触发后的回执轮询会让冷却一直续期。
 *
 * 这里的策略：
 * - 所有 bundler 请求走同一个队列，默认 5 次/分钟、最小间隔 10 秒；
 * - 遇到 `Failed to fetch` / HTTP 429 / 5xx 时全局冷却 60 秒，冷却期间请求排队；
 * - 冷却后速率减半，连续成功再逐步恢复；
 * - 只读回执支持 JSON-RPC 批量，把 N 次 HTTP 压成 1 次。
 */

import type { AaChainConfig } from '../chains'
import type { RpcBatchItem, RpcBatchRequest, RpcEndpoint } from '../rpc'
import { RpcError, rpcBatch, rpcCall } from '../rpc'
import { BundlerPacer } from './limiter'
import type { BundlerPacerConfig, BundlerPacerStatus } from './limiter'

const DEFAULT_CONFIG: BundlerPacerConfig = {
  maxPerWindow: 5,
  windowMs: 60_000,
  minIntervalMs: 10_000,
  cooldownMs: 60_000,
  recoverAfterSuccesses: 10,
}

let pacer = new BundlerPacer(DEFAULT_CONFIG)
let queue: Promise<unknown> = Promise.resolve()
let pending = 0

export function resetBundlerThrottleForTests(config: Partial<BundlerPacerConfig> = {}): void {
  pacer = new BundlerPacer({ ...DEFAULT_CONFIG, ...config })
  queue = Promise.resolve()
  pending = 0
}

export function bundlerEndpoint(chain: AaChainConfig): RpcEndpoint {
  return { url: chain.bundler, label: 'Pimlico' }
}

/**
 * 是否属于「应该整体冷却」的错误。
 * JSON-RPC 的验证失败（AA2x/AA3x 等）不是限流，不触发冷却。
 */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof RpcError) {
    if (err.kind === 'network' || err.kind === 'timeout') return true
    if (err.kind === 'http') return err.status === 429 || (err.status ?? 0) >= 500
    if (err.kind === 'jsonrpc') {
      return /rate limit|too many|429/i.test(err.message)
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return /Failed to fetch|NetworkError|network|fetch|timeout|超时|HTTP 5\d\d|HTTP 429|rate limit|too many/i.test(
    message,
  )
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  pending += 1
  const run = async () => {
    try {
      return await task()
    } finally {
      pending -= 1
    }
  }
  const result = queue.then(run, run)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** 单次 bundler 调用；maxWaitMs 是排队预算，超过会抛 PacerBusyError。 */
export async function bundlerCall<T>(
  chain: AaChainConfig,
  method: string,
  params: unknown[] = [],
  timeoutMs = 30_000,
  maxWaitMs = 180_000,
): Promise<T> {
  return enqueue(async () => {
    await pacer.acquire(maxWaitMs)
    try {
      const result = await rpcCall<T>(bundlerEndpoint(chain), method, params, timeoutMs)
      pacer.noteSuccess()
      return result
    } catch (err) {
      pacer.noteFailure(isRateLimitError(err))
      throw err
    }
  })
}

/** 一次 HTTP 查多个只读结果（回执等）；整批只占一个限速配额。 */
export async function bundlerBatch<T>(
  chain: AaChainConfig,
  requests: RpcBatchRequest[],
  timeoutMs = 30_000,
  maxWaitMs = 180_000,
): Promise<Map<number, RpcBatchItem<T>>> {
  return enqueue(async () => {
    await pacer.acquire(maxWaitMs)
    try {
      const result = await rpcBatch<T>(bundlerEndpoint(chain), requests, timeoutMs)
      pacer.noteSuccess()
      return result
    } catch (err) {
      pacer.noteFailure(isRateLimitError(err))
      throw err
    }
  })
}

export interface BundlerThrottleStatus extends BundlerPacerStatus {
  /** 队列里等待/进行中的请求数。 */
  pending: number
}

export function getBundlerThrottleStatus(): BundlerThrottleStatus {
  return { ...pacer.status(), pending }
}
