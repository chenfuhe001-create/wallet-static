import { useEffect, useState } from 'react'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import {
  addWallet,
  closeVault,
  createVault,
  exportVaultJson,
  parseVaultJson,
  unlockVault,
} from './crypto/vault'
import { computeUserOpHash } from './evm/op'

const PASSWORD = 'selftest-password-123'

/** 浏览器内自检：真实跑 Argon2id/解密/新增/UserOp 哈希/BSC 离线签名；不写 IndexedDB。 */
export default function SelfTest() {
  const [lines, setLines] = useState<string[]>(['selftest starting…'])
  const [ok, setOk] = useState<boolean | null>(null)

  useEffect(() => {
    void (async () => {
      const out: string[] = []
      const t0 = performance.now()
      try {
        out.push('1/6 createVault (Argon2id 256MiB)…')
        setLines([...out])
        const created = await createVault({ password: PASSWORD, privateKeys: [generatePrivateKey()] })
        const t1 = performance.now()
        out.push(`1/6 ok ${(t1 - t0).toFixed(0)}ms, wallets=${created.wallets.length}`)

        out.push('2/6 export/parse/unlock…')
        setLines([...out])
        const text = exportVaultJson(created.data)
        const parsed = parseVaultJson(text)
        const reopened = await unlockVault(parsed, PASSWORD)
        out.push(`2/6 ok wallets=${reopened.wallets.length}, address=${reopened.wallets[0]?.address}`)

        out.push('3/6 addWallet…')
        setLines([...out])
        const added = await addWallet(reopened, generatePrivateKey(), 'selftest')
        out.push(`3/6 ok id=${added.id}, total=${reopened.wallets.length}`)

        out.push('4/6 BSC offline sign…')
        setLines([...out])
        const account = privateKeyToAccount(reopened.wallets[0].privateKey)
        const signed = await account.signTransaction({
          chainId: 56,
          to: '0x000000000000000000000000000000000000dEaD',
          value: 1n,
          gas: 21000n,
          gasPrice: 1n,
          nonce: 0,
        })
        if (!signed.startsWith('0x') || signed.length < 100) throw new Error('BSC 签名长度异常')
        out.push(`4/6 ok txBytes=${(signed.length - 2) / 2}`)

        out.push('5/6 UserOp EIP-712 hash/sign…')
        setLines([...out])
        const userOpHash = computeUserOpHash({
          sender: account.address,
          nonce: 7n,
          initCode: '0x',
          callData: '0xdeadbeef',
          accountGasLimits:
            '0x0000000000000000000000000001b2070000000000000000000000000003640e' as Hex,
          preVerificationGas: 120000n,
          gasFees: '0x000000000000000000000000000f4240000000000000000000000000001e8480' as Hex,
          paymasterAndData: '0x',
        })
        const sig = await account.sign({ hash: userOpHash })
        if (sig.length !== 132) throw new Error('UserOp 签名长度异常')
        out.push(`5/6 ok hash=${userOpHash.slice(0, 10)}… sig=${sig.slice(0, 10)}…`)

        out.push('6/6 cleanup…')
        closeVault(reopened)
        closeVault(created)
        out.push(`SELFTEST OK total=${(performance.now() - t0).toFixed(0)}ms`)
        setLines([...out])
        setOk(true)
      } catch (e) {
        out.push(`SELFTEST FAIL: ${e instanceof Error ? e.message : String(e)}`)
        setLines([...out])
        setOk(false)
      }
    })()
  }, [])

  return (
    <div className="app">
      <h1>本地钱包自检</h1>
      <p className="muted">仅运行本地加密/签名，不保存保险箱、不联网、不发交易。</p>
      <pre className="result" style={{ whiteSpace: 'pre-wrap' }}>
        {lines.join('\n')}
      </pre>
      {ok === true ? <div className="notice">SELFTEST OK</div> : null}
      {ok === false ? <div className="error">SELFTEST FAIL</div> : null}
    </div>
  )
}
