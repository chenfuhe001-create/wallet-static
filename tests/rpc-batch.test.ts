import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcError, rpcBatch } from '../src/rpc'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('JSON-RPC 批量读取', () => {
  it('按 id 返回每项结果，单项错误不丢', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { jsonrpc: '2.0', id: 7, result: '0xa' },
          { jsonrpc: '2.0', id: 8, error: { code: -32602, message: 'bad params' } },
        ],
      })),
    )
    const out = await rpcBatch({ url: 'https://bundler.example', label: 'test' }, [
      { id: 7, method: 'eth_chainId', params: [] },
      { id: 8, method: 'eth_call', params: [] },
    ])
    expect(out.get(7)?.result).toBe('0xa')
    expect(out.get(8)?.error?.message).toBe('bad params')
    expect(out.get(8)?.result).toBeUndefined()
  })

  it('HTTP 429 标记为限流错误，供调用方冷却', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
      })),
    )
    const err = await rpcBatch({ url: 'https://bundler.example', label: 'test' }, [
      { id: 1, method: 'eth_chainId', params: [] },
    ]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).kind).toBe('http')
    expect((err as RpcError).status).toBe(429)
  })
})
