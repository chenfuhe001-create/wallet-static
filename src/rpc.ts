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
