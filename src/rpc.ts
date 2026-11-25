/** 极简 JSON-RPC 客户端：浏览器直连，不经任何后端。 */

export interface RpcEndpoint {
  url: string
  label: string
}

export class RpcError extends Error {
  constructor(message: string, readonly endpoint?: string) {
    super(message)
    this.name = 'RpcError'
  }
}

/** 广播前的失败（读 RPC/估算/签名）：交易肯定没有发出，可安全重试。 */
export class PreBroadcastError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'PreBroadcastError'
  }
}

/** 已发出广播请求但没拿到哈希：可能已上链，结果不明。 */
export class AmbiguousBroadcastError extends Error {
  constructor(
    message: string,
    readonly userOpHash?: string,
    readonly txHash?: string,
  ) {
    super(message)
    this.name = 'AmbiguousBroadcastError'
  }
}

/** 网络抖动/限流：可以退避重试；限流通常约 30 秒恢复。 */
export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /Failed to fetch|NetworkError|network|fetch|超时|timeout|HTTP 5\d\d|HTTP 429|rate limit|too many/i.test(
    message,
  )
}

/** 已广播但链上执行失败的交易；批量重试时必须识别，避免重复转账。 */
export class BroadcastError extends Error {
  constructor(message: string, readonly hash: string) {
    super(message)
    this.name = 'BroadcastError'
  }
}

export async function rpcCall<T = unknown>(
  endpoint: RpcEndpoint,
  method: string,
  params: unknown[] = [],
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: controller.signal,
      // 不携带任何 cookie/凭据
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`, endpoint.url)
    const body = (await res.json()) as { result?: T; error?: { message?: string } }
    if (body.error) throw new RpcError(body.error.message || 'RPC error', endpoint.url)
    return body.result as T
  } catch (err) {
    if (err instanceof RpcError) throw err
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new RpcError('RPC 请求超时', endpoint.url)
    }
    throw new RpcError(err instanceof Error ? err.message : 'RPC 请求失败', endpoint.url)
  } finally {
    clearTimeout(timer)
  }
}

/** 依次尝试多个 endpoint（只用于只读请求；广播不要自动换 endpoint 重发）。 */
export async function rpcRead<T>(
  endpoints: RpcEndpoint[],
  method: string,
  params: unknown[] = [],
  timeoutMs = 15_000,
): Promise<T> {
  let last: unknown
  for (const endpoint of endpoints) {
    try {
      return await rpcCall<T>(endpoint, method, params, timeoutMs)
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new RpcError('所有 RPC 都不可用')
}

export function toHex(value: bigint | number): `0x${string}` {
  const n = typeof value === 'bigint' ? value : BigInt(value)
  return `0x${n.toString(16)}`
}

export function hexToBigInt(value: string): bigint {
  if (!value || value === '0x') return 0n
  return BigInt(value)
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
