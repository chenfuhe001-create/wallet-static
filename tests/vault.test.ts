import { describe, expect, it } from 'vitest'
import fixture from './fixtures/vault-test.json'
import {
  addWallet,
  changePassword,
  closeVault,
  createVault,
  exportVaultJson,
  parseVaultJson,
  unlockVault,
} from '../src/crypto/vault'
import type { EncryptedVault } from '../src/crypto/vault'

const PASSWORD = 'test-password-123'

describe('vault compatibility', () => {
  it('opens a server-generated wallet vault', async () => {
    const opened = await unlockVault(fixture as unknown as EncryptedVault, PASSWORD)
    expect(opened.wallets).toHaveLength(2)
    expect(opened.wallets[0].address).toBe('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A')
    expect(opened.wallets[0].privateKey).toBe(`0x${'11'.repeat(32)}`)
    expect(opened.wallets[1].privateKey).toBe(`0x${'22'.repeat(32)}`)
    closeVault(opened)
  })

  it('rejects a wrong password with a generic error', async () => {
    await expect(unlockVault(fixture as unknown as EncryptedVault, 'wrong-password-123')).rejects.toThrow(
      '钱包密码错误',
    )
  })

  it('creates, exports and re-imports a local vault', async () => {
    const key = `0x${'33'.repeat(32)}` as const
    const created = await createVault({ password: PASSWORD, privateKeys: [key], label: 'local' })
    expect(created.wallets).toHaveLength(1)
    const json = exportVaultJson(created.data)
    const parsed = parseVaultJson(json)
    const reopened = await unlockVault(parsed, PASSWORD)
    expect(reopened.wallets[0].privateKey).toBe(key)
    closeVault(reopened)
    closeVault(created)
  })

  it('adds a wallet and keeps ids monotonic', async () => {
    const created = await createVault({ password: PASSWORD })
    const first = await addWallet(created, `0x${'44'.repeat(32)}`, 'a')
    const second = await addWallet(created, `0x${'55'.repeat(32)}`, 'b')
    expect(second.id).toBeGreaterThan(first.id)
    const reopened = await unlockVault(parseVaultJson(exportVaultJson(created.data)), PASSWORD)
    expect(reopened.wallets.map((w) => w.id)).toEqual([first.id, second.id])
    closeVault(reopened)
    closeVault(created)
  })

  it('re-encrypts with a new password', async () => {
    const key = `0x${'66'.repeat(32)}` as const
    const created = await createVault({
      password: PASSWORD,
      privateKeys: [key],
      kdfOps: 1,
      kdfMem: 4 * 1024 * 1024,
    })
    const changed = await changePassword(created, 'new-password-456', 1, 4 * 1024 * 1024)
    const reopened = await unlockVault(parseVaultJson(exportVaultJson(changed.data)), 'new-password-456')
    expect(reopened.wallets[0].privateKey).toBe(key)
    await expect(
      unlockVault(parseVaultJson(exportVaultJson(changed.data)), PASSWORD),
    ).rejects.toThrow('钱包密码错误')
    closeVault(reopened)
    closeVault(changed)
  })
})
