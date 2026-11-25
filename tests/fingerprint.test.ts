import { describe, expect, it } from 'vitest'
import {
  deriveFingerprintKey,
  fromBase64Url,
  toBase64Url,
  unwrapPassword,
  wrapPassword,
} from '../src/crypto/fingerprint'

const PRF = new Uint8Array(32).fill(7)
const SALT = new Uint8Array(32).fill(9)
const PASSWORD = 'correct-horse-battery-staple'

describe('指纹包装钱包密码', () => {
  it('base64url 编解码可逆且不含 URL 特殊字符', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63])
    const encoded = toBase64Url(bytes)
    expect(encoded).not.toContain('=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(fromBase64Url(encoded)).toEqual(bytes)
  })

  it('派生 256 位 AES-GCM 密钥，盐不同则解不开', async () => {
    const key = await deriveFingerprintKey(PRF, SALT)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    const wrapped = await wrapPassword(PRF, SALT, PASSWORD)
    await expect(unwrapPassword(PRF, new Uint8Array(32).fill(8), wrapped)).rejects.toThrow('指纹')
    await expect(unwrapPassword(PRF, SALT, wrapped)).resolves.toBe(PASSWORD)
  })

  it('PRF 输出不同则无法解密', async () => {
    const wrapped = await wrapPassword(PRF, SALT, PASSWORD)
    await expect(unwrapPassword(new Uint8Array(32).fill(6), SALT, wrapped)).rejects.toThrow(
      '指纹验证失败',
    )
  })

  it('IV 为 12 字节且密文非空', async () => {
    const wrapped = await wrapPassword(PRF, SALT, PASSWORD)
    expect(fromBase64Url(wrapped.iv)).toHaveLength(12)
    expect(fromBase64Url(wrapped.ciphertext).length).toBeGreaterThan(PASSWORD.length)
  })

  it('同一密码两次包装的 IV/密文不同（随机 IV）', async () => {
    const first = await wrapPassword(PRF, SALT, PASSWORD)
    const second = await wrapPassword(PRF, SALT, PASSWORD)
    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })
})
