import { describe, expect, it } from 'vitest'
import { hashTypedData } from 'viem'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { OP, getAaChain } from '../src/chains'
import { computeUserOpHash } from '../src/evm/op'

const KEY = `0x${'11'.repeat(32)}` as const
const SENDER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const EXPECTED_HASH = '0x9e9d6d85567acb3086c841d97dec89bf5e179ae8aa09431eeb0b5bfbd12639d6'
const EXPECTED_SIG =
  '0x068b3e369e3b3d2f2bfe455cd00f8d52bfb5dcc2b0c1c18419999aa27f1c9db55651ed41dcbb15efede801783394bf75d8ebf27ea182a7bedb397a6475b7627d1b'

const PACKED_USEROP_TYPES = {
  PackedUserOperation: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'gasFees', type: 'bytes32' },
    { name: 'paymasterAndData', type: 'bytes' },
  ],
} as const

const CROSS_CHAIN_INPUT = {
  sender: SENDER,
  nonce: 7n,
  initCode: '0x' as Hex,
  callData: '0xdeadbeef' as Hex,
  accountGasLimits:
    '0x0000000000000000000000000001b2070000000000000000000000000003640e' as Hex,
  preVerificationGas: 120000n,
  gasFees: '0x000000000000000000000000000f4240000000000000000000000000001e8480' as Hex,
  paymasterAndData: '0x' as Hex,
}

/** 用 viem 的 EIP-712 实现独立复算，避免拿被测代码给被测代码当答案。 */
function oracleHash(chainId: number, entrypoint: `0x${string}`): Hex {
  return hashTypedData({
    domain: { name: 'ERC4337', version: '1', chainId, verifyingContract: entrypoint },
    types: PACKED_USEROP_TYPES,
    primaryType: 'PackedUserOperation',
    message: {
      sender: CROSS_CHAIN_INPUT.sender as Hex,
      nonce: CROSS_CHAIN_INPUT.nonce,
      initCode: CROSS_CHAIN_INPUT.initCode,
      callData: CROSS_CHAIN_INPUT.callData,
      accountGasLimits: CROSS_CHAIN_INPUT.accountGasLimits,
      preVerificationGas: CROSS_CHAIN_INPUT.preVerificationGas,
      gasFees: CROSS_CHAIN_INPUT.gasFees,
      paymasterAndData: CROSS_CHAIN_INPUT.paymasterAndData,
    },
  })
}

describe('EntryPoint v0.8 UserOp vector', () => {
  it('matches server hash and signature exactly', async () => {
    const account = privateKeyToAccount(KEY)
    expect(account.address).toBe(SENDER)
    const hash = computeUserOpHash(
      {
        sender: SENDER,
        nonce: 7n,
        initCode: '0x',
        callData: '0xdeadbeef',
        accountGasLimits:
          '0x0000000000000000000000000001b2070000000000000000000000000003640e' as Hex,
        preVerificationGas: 120000n,
        gasFees: '0x000000000000000000000000000f4240000000000000000000000000001e8480' as Hex,
        paymasterAndData:
          '0x0578cfb241215b77442a541325d6a4e6dfe700ec000000000000000000000000000493e000000000000000000000000000013880000b2c639c533813f4aa9d7837caf62653d097ff85000000000000000000000000000000000000000000000000000000000000c350aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex,
      },
      OP,
    )
    expect(hash).toBe(EXPECTED_HASH)
    const signature = await account.sign({ hash })
    expect(signature).toBe(EXPECTED_SIG)
  })

  it('matches 7702 delegate initCode override', () => {
    const hash = computeUserOpHash(
      {
        sender: SENDER,
        nonce: 7n,
        initCode: '0x',
        callData: '0xdeadbeef',
        accountGasLimits:
          '0x0000000000000000000000000001b2070000000000000000000000000003640e' as Hex,
        preVerificationGas: 120000n,
        gasFees: '0x000000000000000000000000000f4240000000000000000000000000001e8480' as Hex,
        paymasterAndData: '0x',
        delegate: '0xe6Cae83BdE06E4c305530e199D7217f42808555B',
        factoryData: '0x',
      },
      OP,
    )
    expect(hash).toBe('0xa347979b3869171bf6fb233b609b5af47f6aff624ecfd20486ed5247f90c93ac')
  })

  it('把链的 chainId 与 EntryPoint 编进域分隔符', () => {
    const base = getAaChain('base')
    expect(computeUserOpHash(CROSS_CHAIN_INPUT, base)).toBe(oracleHash(base.id, base.entrypoint))
    expect(computeUserOpHash(CROSS_CHAIN_INPUT, OP)).toBe(oracleHash(OP.id, OP.entrypoint))
    expect(computeUserOpHash(CROSS_CHAIN_INPUT, base)).not.toBe(
      computeUserOpHash(CROSS_CHAIN_INPUT, OP),
    )
  })
})
