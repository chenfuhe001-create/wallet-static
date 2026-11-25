import { describe, expect, it } from 'vitest'
import { classifyBundlerSendError } from '../src/evm/sendError'
import { PreBroadcastError, RpcError } from '../src/rpc'

describe('bundler 发送失败分类', () => {
  it('网络/传输错误不能当作可重试：结果不明', () => {
    expect(
      classifyBundlerSendError(new RpcError('Failed to fetch', undefined, 'network')),
    ).toBe('ambiguous')
    expect(classifyBundlerSendError(new RpcError('RPC 请求超时', undefined, 'timeout'))).toBe(
      'ambiguous',
    )
  })

  it('AA25 / already known 可能已上链，必须结果不明', () => {
    expect(
      classifyBundlerSendError(
        new RpcError('AA25 invalid account nonce', undefined, 'jsonrpc'),
      ),
    ).toBe('ambiguous')
    expect(
      classifyBundlerSendError(new RpcError('already known', undefined, 'jsonrpc')),
    ).toBe('ambiguous')
  })

  it('明确的验证失败（nonce 未变时）可安全重试', () => {
    expect(
      classifyBundlerSendError(
        new RpcError('AA21 didn’t pay prefund', undefined, 'jsonrpc'),
      ),
    ).toBe('retryable')
    expect(
      classifyBundlerSendError(
        new RpcError('AA33 reverted: paymaster validation failed', undefined, 'jsonrpc'),
      ),
    ).toBe('retryable')
    expect(classifyBundlerSendError(new PreBroadcastError('本地签名失败'))).toBe('retryable')
  })

  it('未知错误按结果不明处理，宁可人工核对也不自动重发', () => {
    expect(classifyBundlerSendError(new Error('boom'))).toBe('ambiguous')
  })
})
