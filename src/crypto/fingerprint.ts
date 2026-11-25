/**
 * 本地指纹解锁（WebAuthn PRF）：
 * PRF 输出 → HKDF-SHA256 → AES-256-GCM 包装「钱包密码」；只存本机 localStorage。
 *
 * 边界：只包密码，不包私钥/DataKey；解锁后仍由 Argon2 保险箱解密。
 * 不是零知识——XSS/恶意扩展仍可能在解锁瞬间截获密码，页面保持严格 CSP。
 */

const STORAGE_KEY = 'wallet-static-fingerprint-v1'
const INFO = 'wallet-static-fingerprint-v1'
const VERSION = 1

export interface FingerprintBlob {
  version: number
  credentialId: string
  salt: string
  iv: string
  ciphertext: string
  rpId: string
  createdAt: number
}

export interface WrappedPassword {
  iv: string
  ciphertext: string
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** PRF 输出经 HKDF 派生 AES-256-GCM 密钥；盐每次启用随机生成。 */
export async function deriveFingerprintKey(
  prfOutput: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(INFO) },
    base,
    256,
  )
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function wrapPassword(
  prfOutput: Uint8Array,
  salt: Uint8Array,
  password: string,
): Promise<WrappedPassword> {
  const key = await deriveFingerprintKey(prfOutput, salt)
  const iv = randomBytes(12)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(password)),
  )
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) }
}

export async function unwrapPassword(
  prfOutput: Uint8Array,
  salt: Uint8Array,
  wrapped: WrappedPassword,
): Promise<string> {
  try {
    const key = await deriveFingerprintKey(prfOutput, salt)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(wrapped.iv) },
      key,
      fromBase64Url(wrapped.ciphertext),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    throw new Error('指纹验证失败或凭据已失效，请改用钱包密码')
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isBlob(value: unknown): value is FingerprintBlob {
  if (!value || typeof value !== 'object') return false
  const blob = value as Record<string, unknown>
  return (
    blob.version === VERSION &&
    ['credentialId', 'salt', 'iv', 'ciphertext', 'rpId'].every((key) => typeof blob[key] === 'string') &&
    typeof blob.createdAt === 'number'
  )
}

export function loadFingerprint(): FingerprintBlob | null {
  const raw = storage()?.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isBlob(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveFingerprint(blob: FingerprintBlob): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(blob))
}

export function clearFingerprint(): void {
  storage()?.removeItem(STORAGE_KEY)
}

export function hasFingerprint(): boolean {
  return loadFingerprint() !== null
}

/** 非安全上下文（非 HTTPS/localhost）或缺少 WebAuthn 时不可用。 */
export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function'
  )
}

function prfFirst(credential: PublicKeyCredential): ArrayBuffer | undefined {
  const results = (
    credential.getClientExtensionResults() as unknown as {
      prf?: { results?: { first?: ArrayBuffer } }
    }
  ).prf
  return results?.results?.first
}

function rpId(): string {
  return window.location.hostname
}

/** 创建 passkey 并用 PRF 包装密码；浏览器不支持 PRF 时抛错（凭据无法删除，只能停用）。 */
export async function enableFingerprint(password: string): Promise<FingerprintBlob> {
  if (!password) throw new Error('请输入当前钱包密码')
  if (!isWebAuthnSupported()) {
    throw new Error('当前环境不支持 WebAuthn/指纹（需要 HTTPS 或 localhost）')
  }
  const salt = randomBytes(32)
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { id: rpId(), name: '本地钱包 wallet-static' },
      user: { id: randomBytes(16), name: `wallet-${Date.now()}`, displayName: '本地钱包' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 60_000,
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      extensions: { prf: { eval: { first: salt } } },
    } as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('已取消指纹创建')
  const first = prfFirst(credential)
  if (!first) {
    throw new Error('该浏览器/设备不支持 PRF，指纹解锁不可用；请继续用密码')
  }

  const wrapped = await wrapPassword(new Uint8Array(first), salt, password)
  const blob: FingerprintBlob = {
    version: VERSION,
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    salt: toBase64Url(salt),
    iv: wrapped.iv,
    ciphertext: wrapped.ciphertext,
    rpId: rpId(),
    createdAt: Date.now(),
  }
  saveFingerprint(blob)
  return blob
}

/** 用指纹解出钱包密码；随后仍走本地 Argon2 保险箱解锁。 */
export async function unlockWithFingerprint(): Promise<string> {
  const blob = loadFingerprint()
  if (!blob) throw new Error('本机未启用指纹解锁')
  if (!isWebAuthnSupported()) throw new Error('当前环境不支持 WebAuthn/指纹')
  if (blob.rpId !== rpId()) {
    throw new Error('指纹凭据与当前域名不匹配，请用钱包密码解锁')
  }
  const salt = fromBase64Url(blob.salt)
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: blob.rpId,
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(blob.credentialId) as BufferSource }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } },
    } as unknown as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null
  if (!assertion) throw new Error('已取消指纹验证')
  const first = prfFirst(assertion)
  if (!first) throw new Error('指纹 PRF 不可用，请用钱包密码解锁')
  return unwrapPassword(new Uint8Array(first), salt, {
    iv: blob.iv,
    ciphertext: blob.ciphertext,
  })
}
