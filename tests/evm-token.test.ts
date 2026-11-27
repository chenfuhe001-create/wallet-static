import { decodeAbiParameters, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { encodeErc20TransferData } from '../src/evm/native'

describe('BSC BTCB 代币转账数据', () => {
  it('编码 transfer(address,uint256) 选择器与参数', () => {
    const to = '0x1111111111111111111111111111111111111111'
    const data = encodeErc20TransferData(to, 123456789n)
    expect(data.slice(0, 10)).toBe('0xa9059cbb')
    const [recipient, amount] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      `0x${data.slice(10)}` as Hex,
    )
    expect(recipient.toLowerCase()).toBe(to)
    expect(amount).toBe(123456789n)
  })
})
