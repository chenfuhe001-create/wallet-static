import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { computeUserOpHash } from '../src/evm/op'

const KEY = `0x${'11'.repeat(32)}` as const
const SENDER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const EXPECTED_HASH = '0x9e9d6d85567acb3086c841d97dec89bf5e179ae8aa09431eeb0b5bfbd12639d6'
const EXPECTED_SIG =
  '0x068b3e369e3b3d2f2bfe455cd00f8d52bfb5dcc2b0c1c18419999aa27f1c9db55651ed41dcbb15efede801783394bf75d8ebf27ea182a7bedb397a6475b7627d1b'

describe('EntryPoint v0.8 UserOp vector', () => {
  it('matches server hash and signature exactly', async () => {
    const account = privateKeyToAccount(KEY)
    expect(account.address).toBe(SENDER)
    const hash = computeUserOpHash({
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
    })
    expect(hash).toBe(EXPECTED_HASH)
    const signature = await account.sign({ hash })
    expect(signature).toBe(EXPECTED_SIG)
  })
})
