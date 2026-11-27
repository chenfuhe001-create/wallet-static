/** 地址簿业务层：独立密码、独立密文文件、与钱包保险箱无关。 */

import {
  AddressBookDecryptError,
  AddressBookError,
  DEFAULT_KDF_MEM,
  DEFAULT_KDF_OPS,
  KDF_MEM_MAX,
  KDF_MEM_MIN,
  KDF_OPS_MAX,
  MAX_ENTRIES,
  META_VERSION,
  SCHEME,
  CIPHER,
  KDF_ALGO,
  createAddressBook,
  decryptEntry,
  encryptEntry,
  exportAddressBook,
  now,
  unlockAddressBook,
  validateAddress,
  validateLabel,
  validateNote,
  validatePassword,
  zeroKey,
} from './crypto'
import type { AddressBookStorage } from './storage'
import type {
  AddressBookEntry,
  AddressBookEntryRecord,
  AddressBookFile,
  AddressBookImportResult,
  AddressBookMeta,
  AddressBookStatus,
} from './types'

export interface AddressBookOptions {
  kdfOps?: number
  kdfMem?: number
}

function parseFile(value: unknown): AddressBookFile {
  if (!value || typeof value !== 'object') throw new AddressBookError('地址簿格式无效')
  const file = value as Partial<AddressBookFile>
  const meta = file.meta as Partial<AddressBookMeta> | undefined
  const entries = file.entries
  if (!meta || !Array.isArray(entries)) throw new AddressBookError('地址簿格式无效')
  if (Number(meta.version) !== META_VERSION || meta.scheme !== SCHEME) {
    throw new AddressBookError('不支持的地址簿版本')
  }
  if (!meta.kdf || !meta.wrapNonce || !meta.wrappedKey) throw new AddressBookError('地址簿格式无效')
  const rows: AddressBookEntryRecord[] = []
  const seenIds = new Set<number>()
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') throw new AddressBookError('地址簿条目格式无效')
    const row = raw as AddressBookEntryRecord
    const id = Number(row.id)
    if (!Number.isInteger(id) || id < 1 || seenIds.has(id)) throw new AddressBookError('地址簿编号重复或非法')
    if (!row.cipher || typeof row.cipher !== 'object') throw new AddressBookError('地址簿条目缺少密文')
    seenIds.add(id)
    rows.push({
      id,
      created_at: String(row.created_at ?? ''),
      updated_at: String(row.updated_at ?? ''),
      cipher: row.cipher,
    })
  }
  rows.sort((a, b) => a.id - b.id)
  return {
    meta: {
      version: Number(meta.version),
      scheme: meta.scheme,
      cipher: String(meta.cipher ?? ''),
      next_id: Math.max(Number(meta.next_id ?? 1) || 1, ...rows.map((row) => row.id + 1), 1),
      kdf: {
        algo: String(meta.kdf.algo ?? ''),
        ops: Number(meta.kdf.ops),
        mem: Number(meta.kdf.mem),
        salt: String(meta.kdf.salt ?? ''),
      },
      wrapNonce: String(meta.wrapNonce),
      wrappedKey: String(meta.wrappedKey),
      created_at: String(meta.created_at ?? now()),
      updated_at: String(meta.updated_at ?? now()),
    },
    entries: rows,
  }
}

function statusOf(file: AddressBookFile | null): AddressBookStatus {
  if (!file) {
    return { initialized: false, count: 0, next_id: 1, scheme: SCHEME, updated_at: null }
  }
  return {
    initialized: true,
    count: file.entries.length,
    next_id: Number(file.meta.next_id),
    scheme: String(file.meta.scheme),
    updated_at: file.meta.updated_at ?? null,
  }
}

export class AddressBookService {
  private file: AddressBookFile | null = null
  private dataKey: Uint8Array | null = null
  private entries: AddressBookEntry[] | null = null

  constructor(
    private readonly storage: AddressBookStorage,
    private readonly options: AddressBookOptions = {},
  ) {}

  async init(): Promise<AddressBookStatus> {
    this.file = await this.storage.load()
    return statusOf(this.file)
  }

  status(): AddressBookStatus {
    return statusOf(this.file)
  }

  isUnlocked(): boolean {
    return this.dataKey !== null && this.entries !== null
  }

  get entriesSnapshot(): AddressBookEntry[] {
    if (!this.entries) throw new AddressBookError('请先解锁地址簿')
    return this.entries.map((entry) => ({ ...entry }))
  }

  private async ensureFile(): Promise<AddressBookFile> {
    if (!this.file) this.file = await this.storage.load()
    if (!this.file) throw new AddressBookError('地址簿尚未创建')
    return this.file
  }

  private ensureUnlocked(): { file: AddressBookFile; dataKey: Uint8Array } {
    if (!this.file || !this.dataKey || !this.entries) throw new AddressBookError('请先解锁地址簿')
    return { file: this.file, dataKey: this.dataKey }
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    await this.storage.save(this.file)
  }

  async create(
    password: string,
    first?: { address: string; label?: string; note?: string },
  ): Promise<AddressBookStatus> {
    validatePassword(password)
    const existing = await this.storage.load()
    if (existing) throw new AddressBookError('地址簿已存在，请直接解锁')
    const { meta, dataKey } = await createAddressBook(password, {
      kdfOps: this.options.kdfOps ?? DEFAULT_KDF_OPS,
      kdfMem: this.options.kdfMem ?? DEFAULT_KDF_MEM,
    })
    const file: AddressBookFile = { meta, entries: [] }
    this.file = file
    this.dataKey = dataKey
    this.entries = []
    try {
      if (first) await this.add(first.address, first.label, first.note)
      else await this.persist()
      return statusOf(this.file)
    } catch (err) {
      // 创建失败不留下半成品
      this.lock()
      this.file = null
      await this.storage.clear().catch(() => undefined)
      throw err
    }
  }

  async unlock(password: string): Promise<AddressBookEntry[]> {
    const file = await this.ensureFile()
    const dataKey = await unlockAddressBook(file, password)
    try {
      const entries: AddressBookEntry[] = []
      for (const row of file.entries) entries.push(await decryptEntry(row, dataKey))
      entries.sort((a, b) => a.id - b.id)
      this.dataKey = dataKey
      this.entries = entries
      return entries.map((entry) => ({ ...entry }))
    } catch (err) {
      zeroKey(dataKey)
      throw err
    }
  }

  async add(address: string, label = '', note = ''): Promise<AddressBookEntry> {
    const { file, dataKey } = this.ensureUnlocked()
    const checked = validateAddress(address)
    const cleanLabel = validateLabel(label)
    const cleanNote = validateNote(note)
    if (file.entries.length >= MAX_ENTRIES) throw new AddressBookError(`地址本最多 ${MAX_ENTRIES} 条`)
    const wanted = checked.toLowerCase()
    if (this.entries?.some((entry) => entry.address.toLowerCase() === wanted)) {
      throw new AddressBookError('这个地址已经在地址本里了')
    }
    const id = Number(file.meta.next_id)
    const stamp = now()
    const cipher = await encryptEntry({ address: checked, label: cleanLabel, note: cleanNote }, dataKey, id)
    const record: AddressBookEntryRecord = { id, created_at: stamp, updated_at: stamp, cipher }
    file.entries.push(record)
    file.meta.next_id = id + 1
    file.meta.updated_at = stamp
    const entry: AddressBookEntry = {
      id,
      address: checked,
      label: cleanLabel,
      note: cleanNote,
      created_at: stamp,
      updated_at: stamp,
    }
    this.entries?.push(entry)
    await this.persist()
    return { ...entry }
  }

  async update(id: number, address: string, label = '', note = ''): Promise<AddressBookEntry> {
    const { file, dataKey } = this.ensureUnlocked()
    const checked = validateAddress(address)
    const cleanLabel = validateLabel(label)
    const cleanNote = validateNote(note)
    const record = file.entries.find((row) => Number(row.id) === Number(id))
    const index = this.entries?.findIndex((entry) => entry.id === Number(id)) ?? -1
    if (!record || index < 0 || !this.entries) throw new AddressBookError('地址不存在')
    const wanted = checked.toLowerCase()
    if (
      this.entries.some(
        (entry) => entry.id !== Number(id) && entry.address.toLowerCase() === wanted,
      )
    ) {
      throw new AddressBookError('这个地址已经在地址本里了')
    }
    const stamp = now()
    record.cipher = await encryptEntry({ address: checked, label: cleanLabel, note: cleanNote }, dataKey, Number(id))
    record.updated_at = stamp
    file.meta.updated_at = stamp
    const entry: AddressBookEntry = {
      id: Number(id),
      address: checked,
      label: cleanLabel,
      note: cleanNote,
      created_at: record.created_at ?? stamp,
      updated_at: stamp,
    }
    this.entries[index] = entry
    await this.persist()
    return { ...entry }
  }

  async remove(id: number): Promise<{ id: number }> {
    const { file } = this.ensureUnlocked()
    const record = file.entries.find((row) => Number(row.id) === Number(id))
    if (!record) throw new AddressBookError('地址不存在')
    file.entries = file.entries.filter((row) => row !== record)
    file.meta.updated_at = now()
    this.entries = (this.entries ?? []).filter((entry) => entry.id !== Number(id))
    await this.persist()
    return { id: Number(id) }
  }

  async exportBlob(): Promise<AddressBookFile> {
    const file = await this.ensureFile()
    return exportAddressBook(file)
  }

  async importBlob(password: string, payload: unknown, confirm = false): Promise<AddressBookImportResult> {
    if (!password) throw new AddressBookError('请输入备份文件的地址本密码')
    const current = await this.storage.load()
    const imported = parseFile(payload)
    const dataKey = await unlockAddressBook(imported, password)
    let normalized: AddressBookFile
    try {
      if (current && current.entries.length > 0 && !confirm) {
        throw new AddressBookError('当前地址本非空，请确认覆盖后再恢复')
      }
      const entries: AddressBookEntry[] = []
      const seen = new Set<string>()
      for (const row of imported.entries) {
        const entry = await decryptEntry(row, dataKey)
        const lower = entry.address.toLowerCase()
        if (seen.has(lower)) throw new AddressBookError(`第 ${row.id} 条地址重复`)
        seen.add(lower)
        entries.push(entry)
      }
      const stamp = now()
      const normalizedMeta: AddressBookMeta = {
        version: META_VERSION,
        scheme: SCHEME,
        cipher: CIPHER,
        next_id: Math.max(Number(imported.meta.next_id) || 1, ...imported.entries.map((row) => row.id + 1), 1),
        kdf: {
          algo: KDF_ALGO,
          ops: Number(imported.meta.kdf.ops),
          mem: Number(imported.meta.kdf.mem),
          salt: String(imported.meta.kdf.salt),
        },
        wrapNonce: String(imported.meta.wrapNonce),
        wrappedKey: String(imported.meta.wrappedKey),
        created_at: imported.meta.created_at || stamp,
        updated_at: stamp,
      }
      normalized = {
        meta: normalizedMeta,
        entries: imported.entries.map((row) => ({
          id: Number(row.id),
          created_at: row.created_at || stamp,
          updated_at: row.updated_at || stamp,
          cipher: row.cipher,
        })),
      }
      if (current) await this.storage.saveBackup(current)
      await this.storage.save(normalized)
      this.file = normalized
      this.dataKey = dataKey
      this.entries = entries.sort((a, b) => a.id - b.id)
      return {
        restored: entries.length,
        backup: current ? 'local-backup' : null,
        status: statusOf(normalized),
      }
    } catch (err) {
      zeroKey(dataKey)
      if (err instanceof AddressBookError) throw err
      if (err instanceof AddressBookDecryptError) throw err
      throw new AddressBookError('地址簿导入失败，当前地址簿未改动')
    }
  }

  lock(): void {
    zeroKey(this.dataKey)
    this.dataKey = null
    this.entries = null
  }

  async clear(): Promise<void> {
    this.lock()
    this.file = null
    await this.storage.clear()
  }
}
