import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, keccak256, pad, stringToHex } from 'viem'
import type { Hex } from 'viem'
import { OP } from '../src/chains'
import { bufferGasLimit, gasEstimateKey, parseUserOpReceipt } from '../src/evm/op'

const HASH = `0x${'ab'.repeat(32)}` as Hex
const TX = `0x${'cd'.repeat(32)}` as Hex
const SPONSORED = keccak256(
  stringToHex('UserOperationSponsored(address,address,bytes32,uint256,uint256,uint256)'),
)

describe('AA gas 估算复用', () => {
  it('首次估算不加缓冲，复用估算按字段加安全缓冲', () => {
    expect(bufferGasLimit('callGasLimit', 100_000n, false)).toBe(100_000n)
    expect(bufferGasLimit('callGasLimit', 100_000n, true)).toBe(170_000n)
    expect(bufferGasLimit('verificationGasLimit', 100_000n, true)).toBe(135_000n)
  })

  it('缓存键区分首次激活、资产和调用笔数', () => {
    const usdc = OP.feeToken
    expect(gasEstimateKey(OP, true, usdc)).not.toBe(gasEstimateKey(OP, false, usdc))
    expect(gasEstimateKey(OP, false, usdc, 1)).not.toBe(gasEstimateKey(OP, false, usdc, 9))
    expect(gasEstimateKey(OP, false, usdc)).toContain(OP.id.toString())
  })
})

describe('UserOp 回执解析', () => {
  it('从 Circle UserOperationSponsored 日志读取 USDC 手续费', () => {
    const fee = 123_456n
    const result = parseUserOpReceipt(OP, HASH, {
      success: true,
      receipt: {
        transactionHash: TX,
        status: '0x1',
        logs: [
          {
            address: OP.paymaster,
            topics: [
              SPONSORED,
              pad(OP.feeToken.address, { size: 32 }),
              pad('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A', { size: 32 }),
            ],
            data: encodeAbiParameters(
              [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
              [HASH, 0n, fee, 0n],
            ),
          },
        ],
      },
    })
    expect(result.status).toBe('success')
    expect(result.txHash).toBe(TX)
    expect(result.feeUsdc).toBe('0.123456')
    expect(result.explorer).toBe(`${OP.explorerTx}${TX}`)
  })

  it('链上 status=0x0 判失败，不把失败当成功', () => {
    const result = parseUserOpReceipt(OP, HASH, {
      success: true,
      receipt: { transactionHash: TX, status: '0x0' },
    })
    expect(result.status).toBe('failed')
  })
})
