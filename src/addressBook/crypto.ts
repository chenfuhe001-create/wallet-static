/**
 * 地址簿加密：与 web/backend/wallet_book.py 完全同格式。
 *
 * 这不是钱包保险箱：地址簿有独立密码、独立 DataKey、独立文件。
 * 任何格式字段（app tag、HKDF info、AAD 顺序、Base64、时间格式）都不能改，
 * 否则 web 导出的地址簿无法在本地打开，本地导出也无法被 web 导入。
 */

import sodium from 'libsodium-wrappers-sumo'
import { getAddress, isAddress } from 'viem'
import type {
  AddressBookCipher,
  AddressBookEntry,
  AddressBookEntryRecord,
  AddressBookFile,
  AddressBookKdf,
  AddressBookMeta,
} from './types'

export const META_VERSION = 1
export const SCHEME = 'wallet-address-book-v1'
export const APP_TAG = 'address-book'
export const KDF_ALGO = 'argon2id13'
export const CIPHER = 'xchacha20poly1305-ietf'
export const RECORD_KDF = 'hkdf-sha256'
export const SALT_LEN = 16
export const NONCE_LEN = 24
export const KEY_LEN = 32
export const MIN_PASSWORD = 12
export const MAX_PASSWORD = 256
export const MAX_ENTRIES = 500
export const MAX_LABEL = 100
export const MAX_NOTE = 500
export const KDF_MEM_MIN = 4 * 1024 * 1024
export const KDF_MEM_MAX = 512 * 1024 * 1024
export const KDF_OPS_MAX = 10
export const DEFAULT_KDF_OPS = 3
export const DEFAULT_KDF_MEM = 256 * 1024 * 1024
export const RECORD_KEY_INFO = new TextEncoder().encode('oe44-wallet-address-book-v1')

export class AddressBookError extends Error {
  constructor(message = '地址簿操作失败') {
    super(message)
    this.name = 'AddressBookError'
  }
}

export class AddressBookDecryptError extends AddressBookError {
  constructor() {
    super('地址簿密码错误，或地址簿文件已损坏')
    this.name = 'AddressBookDecryptError'
  }
}

let sodiumReady: Promise<void> | null = null
async function ready(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready
  await sodiumReady
}

function b64ToBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !value) throw new AddressBookError('地址簿密文字段缺失')
  try {
    const bin = atob(value)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    throw new AddressBookError('地址簿 Base64 编码无效')
  }
}

function bytesToB64(value: Uint8Array): string {
  let bin = ''
  for (const byte of value) bin += String.fromCharCode(byte)
  return btoa(bin)
}

function canonical(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

export function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function validatePassword(password: string): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AddressBookError(`地址本密码至少 ${MIN_PASSWORD} 位`)
  }
  if (password.length > MAX_PASSWORD) throw new AddressBookError('地址本密码过长')
  return password
}

/** web 用 eth_utils.is_address + to_checksum_address；这里用 viem 同口径。 */
export function validateAddress(value: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || !isAddress(text)) {
    throw new AddressBookError('地址不是合法的 EVM 地址（请检查是否复制完整）')
  }
  return getAddress(text)
}

export function validateLabel(value: string | null | undefined): string {
  const text = (value ?? '').trim()
  if (text.length > MAX_LABEL) throw new AddressBookError(`标签最多 ${MAX_LABEL} 个字符`)
  return text
}

export function validateNote(value: string | null | undefined): string {
  const text = (value ?? '').trim()
  if (text.length > MAX_NOTE) throw new AddressBookError(`备注最多 ${MAX_NOTE} 个字符`)
  return text
}

function headerAad(kdf: AddressBookKdf): Uint8Array {
  return canonical({
    v: META_VERSION,
    app: APP_TAG,
    kdf: {
      algo: kdf.algo,
      ops: Number(kdf.ops),
      mem: Number(kdf.mem),
      salt: kdf.salt,
    },
    cipher: CIPHER,
  })
}

function recordAad(id: number): Uint8Array {
  return canonical({
    v: META_VERSION,
    app: APP_TAG,
    id: Number(id),
    kdf: RECORD_KDF,
    cipher: CIPHER,
  })
}

async function hkdfRecordKey(dataKey: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', dataKey, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: RECORD_KEY_INFO },
    base,
    256,
  )
  return new Uint8Array(bits)
}

async function deriveKek(password: string, salt: Uint8Array, ops: number, mem: number): Promise<Uint8Array> {
  await ready()
  return sodium.crypto_pwhash(KEY_LEN, password, salt, ops, mem, sodium.crypto_pwhash_ALG_ARGON2ID13)
}

function parseKdf(meta: AddressBookMeta): { ops: number; mem: number; salt: Uint8Array } {
  if (!meta || meta.version !== META_VERSION || meta.scheme !== SCHEME || meta.cipher !== CIPHER) {
    throw new AddressBookError('不支持的地址簿格式或版本')
  }
  const kdf = meta.kdf
  if (!kdf || kdf.algo !== KDF_ALGO || typeof kdf.salt !== 'string') {
    throw new AddressBookError('不支持的地址簿 KDF')
  }
  const ops = Number(kdf.ops)
  const mem = Number(kdf.mem)
  if (!Number.isInteger(ops) || ops < 1 || ops > KDF_OPS_MAX) throw new AddressBookError('地址簿 KDF ops 参数异常')
  if (!Number.isInteger(mem) || mem < KDF_MEM_MIN || mem > KDF_MEM_MAX) {
    throw new AddressBookError('地址簿 KDF mem 参数异常')
  }
  const salt = b64ToBytes(kdf.salt)
  if (salt.length !== SALT_LEN) throw new AddressBookError('地址簿盐长度异常')
  return { ops, mem, salt }
}

export async function createAddressBook(
  password: string,
  options: { kdfOps?: number; kdfMem?: number } = {},
): Promise<{ meta: AddressBookMeta; dataKey: Uint8Array }> {
  validatePassword(password)
  await ready()
  const ops = options.kdfOps ?? DEFAULT_KDF_OPS
  const mem = options.kdfMem ?? DEFAULT_KDF_MEM
  const salt = sodium.randombytes_buf(SALT_LEN)
  const dataKey = sodium.randombytes_buf(KEY_LEN)
  const kek = await deriveKek(password, salt, ops, mem)
  const wrapNonce = sodium.randombytes_buf(NONCE_LEN)
  try {
    const kdf: AddressBookKdf = {
      algo: KDF_ALGO,
      ops,
      mem,
      salt: bytesToB64(salt),
    }
    const wrapped = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      dataKey,
      headerAad(kdf),
      null,
      wrapNonce,
      kek,
    )
    const stamp = now()
    const meta: AddressBookMeta = {
      version: META_VERSION,
      scheme: SCHEME,
      cipher: CIPHER,
      next_id: 1,
      kdf,
      wrapNonce: bytesToB64(wrapNonce),
      wrappedKey: bytesToB64(wrapped),
      created_at: stamp,
      updated_at: stamp,
    }
    return { meta, dataKey }
  } finally {
    sodium.memzero(kek)
  }
}

export async function unlockAddressBook(file: AddressBookFile, password: string): Promise<Uint8Array> {
  if (!password) throw new AddressBookError('请输入地址本密码')
  const meta = file?.meta
  if (!meta) throw new AddressBookError('地址簿格式无效')
  const { ops, mem, salt } = parseKdf(meta)
  const wrapped = b64ToBytes(meta.wrappedKey)
  const wrapNonce = b64ToBytes(meta.wrapNonce)
  if (wrapped.length !== KEY_LEN + 16 || wrapNonce.length !== NONCE_LEN) {
    throw new AddressBookError('地址簿密钥数据损坏')
  }
  const kek = await deriveKek(password, salt, ops, mem)
  let dataKey: Uint8Array
  try {
    dataKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      wrapped,
      headerAad(meta.kdf),
      wrapNonce,
      kek,
    )
  } catch {
    throw new AddressBookDecryptError()
  } finally {
    sodium.memzero(kek)
  }
  if (dataKey.length !== KEY_LEN) throw new AddressBookError('地址簿密钥长度异常')
  return dataKey
}

export async function encryptEntry(
  payload: { address: string; label: string; note: string },
  dataKey: Uint8Array,
  id: number,
): Promise<AddressBookCipher> {
  await ready()
  const salt = sodium.randombytes_buf(SALT_LEN)
  const nonce = sodium.randombytes_buf(NONCE_LEN)
  const recordKey = await hkdfRecordKey(dataKey, salt)
  try {
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      canonical(payload),
      recordAad(id),
      null,
      nonce,
      recordKey,
    )
    return {
      scheme: CIPHER,
      kdf: RECORD_KDF,
      salt: bytesToB64(salt),
      nonce: bytesToB64(nonce),
      ciphertext: bytesToB64(ciphertext),
    }
  } finally {
    sodium.memzero(recordKey)
  }
}

export async function decryptEntry(record: AddressBookEntryRecord, dataKey: Uint8Array): Promise<AddressBookEntry> {
  await ready()
  const cipher = record?.cipher
  if (!cipher || cipher.scheme !== CIPHER || cipher.kdf !== RECORD_KDF) {
    throw new AddressBookError('不支持的地址簿记录加密格式')
  }
  const salt = b64ToBytes(cipher.salt)
  const nonce = b64ToBytes(cipher.nonce)
  const ciphertext = b64ToBytes(cipher.ciphertext)
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN) {
    throw new AddressBookError('地址簿记录密文长度异常')
  }
  const recordKey = await hkdfRecordKey(dataKey, salt)
  try {
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      recordAad(Number(record.id)),
      nonce,
      recordKey,
    )
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(plain))
    } catch {
      throw new AddressBookError('地址簿记录内容损坏')
    }
    if (!payload || typeof payload !== 'object') throw new AddressBookError('地址簿记录内容损坏')
    const row = payload as { address?: unknown; label?: unknown; note?: unknown }
    const address = validateAddress(String(row.address ?? ''))
    const label = validateLabel(typeof row.label === 'string' ? row.label : '')
    const note = validateNote(typeof row.note === 'string' ? row.note : '')
    return {
      id: Number(record.id),
      address,
      label,
      note,
      created_at: record.created_at ?? null,
      updated_at: record.updated_at ?? null,
    }
  } catch (err) {
    if (err instanceof AddressBookError) throw err
    throw new AddressBookDecryptError()
  } finally {
    sodium.memzero(recordKey)
  }
}

/** 文件导出：补上 web `export_blob` 的 app/exported_at；密文原样保留。 */
export function exportAddressBook(file: AddressBookFile): AddressBookFile {
  return {
    meta: file.meta,
    entries: file.entries,
    app: SCHEME,
    exported_at: now(),
  }
}

export function zeroKey(key: Uint8Array | null | undefined): void {
  if (!key) return
  try {
    sodium.memzero(key)
  } catch {
    /* 忽略 */
  }
}
