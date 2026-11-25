/**
 * 本地钱包保险箱：与服务器 `wallet_core.py` 完全兼容的浏览器端实现。
 *
 * 加密格式（不能随意改）：
 *   密码 --Argon2id(ops, mem, per-vault salt)--> KEK
 *   DataKey --XChaCha20-Poly1305(KEK, headerAAD)--> wrappedKey
 *   每条：salt(16B) + HKDF-SHA256(DataKey, salt, "dsh-wallet-record-key-v1")
 *         -> recordKey；私钥 --XChaCha20-Poly1305(recordKey, recordAAD)--> ciphertext
 *
 * 约束：
 * - 密码、私钥、DataKey 只在内存；不写 localStorage/IndexedDB 明文、不打日志。
 * - 地址必须由私钥重新推导并和存档比对，失败统一报“密码错误或文件损坏”。
 * - 现有 `wallets.json` 可直接导入；新文件仍是同一格式。
 */

import sodium from 'libsodium-wrappers-sumo'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const META_VERSION = 1
const SCHEME = 'wallet-vault-v1'
const KDF_ALGO = 'argon2id13'
const CIPHER = 'xchacha20poly1305-ietf'
const RECORD_KDF = 'hkdf-sha256'
const SALT_LEN = 16
const NONCE_LEN = 24
const KEY_LEN = 32
const MIN_PASSWORD = 12
const MAX_PASSWORD = 256
const KDF_MEM_MIN = 4 * 1024 * 1024
const KDF_MEM_MAX = 512 * 1024 * 1024
const KDF_OPS_MAX = 10
const RECORD_KEY_INFO = new TextEncoder().encode('dsh-wallet-record-key-v1')
const DEFAULT_OPS = 3
const DEFAULT_MEM = 256 * 1024 * 1024

export interface VaultKdf {
  algo: string
  ops: number
  mem: number
  salt: string
}

export interface VaultCipher {
  scheme: string
  kdf: string
  salt: string
  nonce: string
  ciphertext: string
}

export interface VaultRecord {
  id: number
  address: string
  label: string
  status: 'active' | 'deleted' | string
  created_at: string
  updated_at: string
  cipher: VaultCipher
}

export interface VaultMeta {
  version: number
  next_id: number
  scheme: string
  kdf: VaultKdf
  cipher: string
  wrapNonce: string
  wrappedKey: string
  created_at: string
  updated_at: string
}

export interface EncryptedVault {
  meta: VaultMeta
  wallets: VaultRecord[]
}

export interface OpenedWallet {
  id: number
  address: string
  label: string
  status: string
  createdAt: string
  privateKey: Hex
}

export interface OpenedVault {
  data: EncryptedVault
  dataKey: Uint8Array
  wallets: OpenedWallet[]
}

export class VaultError extends Error {
  constructor(message = '钱包密码错误，或保险箱文件已损坏') {
    super(message)
    this.name = 'VaultError'
  }
}

let sodiumReady: Promise<void> | null = null
async function ready(): Promise<void> {
  if (!sodiumReady) sodiumReady = sodium.ready
  await sodiumReady
}

function b64ToBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !value) throw new VaultError()
  try {
    const bin = atob(value)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    throw new VaultError()
  }
}

function bytesToB64(value: Uint8Array): string {
  let bin = ''
  for (const b of value) bin += String.fromCharCode(b)
  return btoa(bin)
}

function canonical(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function validatePassword(password: string): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`密码至少 ${MIN_PASSWORD} 位`)
  }
  if (password.length > MAX_PASSWORD) throw new Error('密码过长')
  return password
}

function headerAad(kdf: VaultKdf): Uint8Array {
  return canonical({
    v: META_VERSION,
    kdf: {
      algo: kdf.algo,
      ops: Number(kdf.ops),
      mem: Number(kdf.mem),
      salt: kdf.salt,
    },
    cipher: CIPHER,
  })
}

function recordAad(id: number, address: string): Uint8Array {
  return canonical({
    v: META_VERSION,
    id: Number(id),
    address: address.toLowerCase(),
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
  return sodium.crypto_pwhash(
    KEY_LEN,
    password,
    salt,
    ops,
    mem,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
}

function parseKdf(meta: VaultMeta): { ops: number; mem: number; salt: Uint8Array } {
  if (!meta || meta.version !== META_VERSION || meta.scheme !== SCHEME || meta.cipher !== CIPHER) {
    throw new Error('不支持的保险箱格式或版本')
  }
  const kdf = meta.kdf
  if (!kdf || kdf.algo !== KDF_ALGO || typeof kdf.salt !== 'string') {
    throw new Error('不支持的保险箱 KDF')
  }
  const ops = Number(kdf.ops)
  const mem = Number(kdf.mem)
  if (!Number.isInteger(ops) || ops < 1 || ops > KDF_OPS_MAX) throw new Error('KDF ops 参数异常')
  if (!Number.isInteger(mem) || mem < KDF_MEM_MIN || mem > KDF_MEM_MAX) throw new Error('KDF mem 参数异常')
  const salt = b64ToBytes(kdf.salt)
  if (salt.length !== SALT_LEN) throw new Error('保险箱盐长度异常')
  return { ops, mem, salt }
}

function parseWallets(data: EncryptedVault): VaultRecord[] {
  if (!data || !Array.isArray(data.wallets)) throw new Error('保险箱缺少 wallets')
  return data.wallets
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({ ...row, id: Number(row.id) }))
    .filter((row) => Number.isInteger(row.id) && row.id > 0 && typeof row.address === 'string')
}

async function decryptRecord(record: VaultRecord, dataKey: Uint8Array): Promise<Hex> {
  const cipher = record.cipher
  if (!cipher || cipher.scheme !== CIPHER || cipher.kdf !== RECORD_KDF) {
    throw new VaultError('不支持的钱包密文格式')
  }
  const salt = b64ToBytes(cipher.salt)
  const nonce = b64ToBytes(cipher.nonce)
  const ciphertext = b64ToBytes(cipher.ciphertext)
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN || ciphertext.length !== KEY_LEN + 16) {
    throw new VaultError('钱包密文长度异常')
  }
  const recordKey = await hkdfRecordKey(dataKey, salt)
  try {
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      recordAad(record.id, record.address),
      nonce,
      recordKey,
    )
    if (plain.length !== KEY_LEN) throw new VaultError()
    const privateKey = `0x${Array.from(plain, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex
    const derived = privateKeyToAccount(privateKey).address
    if (derived.toLowerCase() !== record.address.toLowerCase()) throw new VaultError()
    return privateKey
  } catch (err) {
    if (err instanceof VaultError) throw err
    throw new VaultError()
  } finally {
    try {
      sodium.memzero(recordKey)
    } catch {
      /* 忽略 */
    }
  }
}

/** 用密码解开整个保险箱；失败统一报 VaultError，不区分密码错/文件坏。 */
export async function unlockVault(data: EncryptedVault, password: string): Promise<OpenedVault> {
  validatePassword(password)
  const { ops, mem, salt } = parseKdf(data.meta)
  const kek = await deriveKek(password, salt, ops, mem)
  let dataKey: Uint8Array
  try {
    const wrapped = b64ToBytes(data.meta.wrappedKey)
    const wrapNonce = b64ToBytes(data.meta.wrapNonce)
    if (wrapped.length !== KEY_LEN + 16 || wrapNonce.length !== NONCE_LEN) throw new VaultError()
    dataKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      wrapped,
      headerAad(data.meta.kdf),
      wrapNonce,
      kek,
    )
    if (dataKey.length !== KEY_LEN) throw new VaultError()
  } catch {
    throw new VaultError()
  } finally {
    try {
      sodium.memzero(kek)
    } catch {
      /* 忽略 */
    }
  }

  try {
    const records = parseWallets(data)
    const wallets: OpenedWallet[] = []
    for (const record of records) {
      const privateKey = await decryptRecord(record, dataKey)
      wallets.push({
        id: record.id,
        address: record.address,
        label: record.label || '',
        status: record.status || 'active',
        createdAt: record.created_at || '',
        privateKey,
      })
    }
    return { data, dataKey, wallets }
  } catch (err) {
    try {
      sodium.memzero(dataKey)
    } catch {
      /* 忽略 */
    }
    throw err instanceof VaultError ? err : new VaultError()
  }
}

async function encryptRecord(
  privateKey: Hex,
  dataKey: Uint8Array,
  id: number,
  address: string,
): Promise<VaultCipher> {
  const salt = sodium.randombytes_buf(SALT_LEN)
  const nonce = sodium.randombytes_buf(NONCE_LEN)
  const recordKey = await hkdfRecordKey(dataKey, salt)
  try {
    const raw = hexToBytes(privateKey)
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      raw,
      recordAad(id, address),
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
    try {
      sodium.memzero(recordKey)
    } catch {
      /* 忽略 */
    }
  }
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('私钥必须是 64 位十六进制')
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export interface CreateVaultInput {
  password: string
  privateKeys?: Hex[]
  label?: string
  kdfOps?: number
  kdfMem?: number
}

/** 新建保险箱（与服务器格式一致），返回加密 JSON 和内存中的打开结果。 */
export async function createVault(input: CreateVaultInput): Promise<OpenedVault> {
  await ready()
  const password = validatePassword(input.password)
  const ops = input.kdfOps ?? DEFAULT_OPS
  const mem = input.kdfMem ?? DEFAULT_MEM
  if (!Number.isInteger(ops) || ops < 1 || ops > KDF_OPS_MAX) throw new Error('KDF ops 参数异常')
  if (!Number.isInteger(mem) || mem < KDF_MEM_MIN || mem > KDF_MEM_MAX) throw new Error('KDF mem 参数异常')

  const salt = sodium.randombytes_buf(SALT_LEN)
  const dataKey = sodium.randombytes_buf(KEY_LEN)
  const kek = await deriveKek(password, salt, ops, mem)
  let wrapNonce: Uint8Array
  let wrapped: Uint8Array
  try {
    wrapNonce = sodium.randombytes_buf(NONCE_LEN)
    const kdf: VaultKdf = { algo: KDF_ALGO, ops, mem, salt: bytesToB64(salt) }
    wrapped = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      dataKey,
      headerAad(kdf),
      null,
      wrapNonce,
      kek,
    )
    const created = now()
    const meta: VaultMeta = {
      version: META_VERSION,
      next_id: 1,
      scheme: SCHEME,
      kdf,
      cipher: CIPHER,
      wrapNonce: bytesToB64(wrapNonce),
      wrappedKey: bytesToB64(wrapped),
      created_at: created,
      updated_at: created,
    }
    const wallets: VaultRecord[] = []
    const opened: OpenedWallet[] = []
    for (const key of input.privateKeys ?? []) {
      const account = privateKeyToAccount(key)
      const id = meta.next_id
      meta.next_id += 1
      const record: VaultRecord = {
        id,
        address: account.address,
        label: input.label || '',
        status: 'active',
        created_at: created,
        updated_at: created,
        cipher: await encryptRecord(key, dataKey, id, account.address),
      }
      wallets.push(record)
      opened.push({
        id,
        address: account.address,
        label: record.label,
        status: 'active',
        createdAt: created,
        privateKey: key,
      })
    }
    return { data: { meta, wallets }, dataKey, wallets: opened }
  } finally {
    try {
      sodium.memzero(kek)
    } catch {
      /* 忽略 */
    }
  }
}

/** 新增钱包到已打开的保险箱（原地修改 data 与 wallets）。 */
export async function addWallet(
  opened: OpenedVault,
  privateKey: Hex,
  label = '',
): Promise<OpenedWallet> {
  const account = privateKeyToAccount(privateKey)
  const address = account.address
  if (opened.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) {
    throw new Error('该地址已存在')
  }
  const meta = opened.data.meta
  const id = Math.max(Number(meta.next_id) || 1, ...opened.wallets.map((w) => w.id + 1))
  meta.next_id = id + 1
  const created = now()
  meta.updated_at = created
  const record: VaultRecord = {
    id,
    address,
    label,
    status: 'active',
    created_at: created,
    updated_at: created,
    cipher: await encryptRecord(privateKey, opened.dataKey, id, address),
  }
  opened.data.wallets.push(record)
  const wallet: OpenedWallet = {
    id,
    address,
    label,
    status: 'active',
    createdAt: created,
    privateKey,
  }
  opened.wallets.push(wallet)
  return wallet
}

/** 关闭保险箱：尽力清零内存密钥。 */
/** 用新密码重新加密整个保险箱（用于迁移后轮换密码）。 */
export async function changePassword(
  opened: OpenedVault,
  newPassword: string,
  kdfOps = DEFAULT_OPS,
  kdfMem = DEFAULT_MEM,
): Promise<OpenedVault> {
  await ready()
  const password = validatePassword(newPassword)
  if (!Number.isInteger(kdfOps) || kdfOps < 1 || kdfOps > KDF_OPS_MAX) throw new Error('KDF ops 参数异常')
  if (!Number.isInteger(kdfMem) || kdfMem < KDF_MEM_MIN || kdfMem > KDF_MEM_MAX) throw new Error('KDF mem 参数异常')
  const salt = sodium.randombytes_buf(SALT_LEN)
  const dataKey = sodium.randombytes_buf(KEY_LEN)
  const kek = await deriveKek(password, salt, kdfOps, kdfMem)
  try {
    const wrapNonce = sodium.randombytes_buf(NONCE_LEN)
    const kdf: VaultKdf = { algo: KDF_ALGO, ops: kdfOps, mem: kdfMem, salt: bytesToB64(salt) }
    const wrapped = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      dataKey,
      headerAad(kdf),
      null,
      wrapNonce,
      kek,
    )
    const updated = now()
    const oldMeta = opened.data.meta
    const meta: VaultMeta = {
      version: META_VERSION,
      next_id: Math.max(Number(oldMeta.next_id) || 1, ...opened.wallets.map((w) => w.id + 1)),
      scheme: SCHEME,
      kdf,
      cipher: CIPHER,
      wrapNonce: bytesToB64(wrapNonce),
      wrappedKey: bytesToB64(wrapped),
      created_at: oldMeta.created_at || updated,
      updated_at: updated,
    }
    const wallets: VaultRecord[] = []
    for (const record of opened.data.wallets) {
      const openedWallet = opened.wallets.find((w) => w.id === record.id)
      if (!openedWallet) throw new Error(`钱包 #${record.id} 缺少明文私钥，无法重新加密`)
      wallets.push({
        ...record,
        updated_at: updated,
        cipher: await encryptRecord(openedWallet.privateKey, dataKey, record.id, record.address),
      })
    }
    try {
      sodium.memzero(opened.dataKey)
    } catch {
      /* 忽略 */
    }
    return { data: { meta, wallets }, dataKey, wallets: opened.wallets }
  } catch (err) {
    try {
      sodium.memzero(dataKey)
    } catch {
      /* 忽略 */
    }
    throw err
  } finally {
    try {
      sodium.memzero(kek)
    } catch {
      /* 忽略 */
    }
  }
}

export function closeVault(opened: OpenedVault | null): void {
  if (!opened) return
  try {
    sodium.memzero(opened.dataKey)
  } catch {
    /* 忽略 */
  }
  for (const wallet of opened.wallets) {
    // JS 字符串不可变，无法真正清零；至少解除引用
    ;(wallet as { privateKey: string }).privateKey = ''
  }
  opened.wallets.length = 0
}

export function exportVaultJson(data: EncryptedVault): string {
  return JSON.stringify(data, null, 2)
}

export function parseVaultJson(text: string): EncryptedVault {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON 文件')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('保险箱格式无效')
  const data = parsed as EncryptedVault
  parseKdf(data.meta)
  parseWallets(data)
  return data
}

export { DEFAULT_MEM, DEFAULT_OPS, MIN_PASSWORD }
