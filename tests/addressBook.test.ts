import { describe, expect, it } from 'vitest'
import { AddressBookService } from '../src/addressBook/service'
import type { AddressBookStorage } from '../src/addressBook/storage'
import type { AddressBookFile } from '../src/addressBook/types'

const PASSWORD = 'address book password 123'
const ADDR1 = '0x' + '11'.repeat(20)
const ADDR2 = '0x' + '22'.repeat(20)
const ADDR3 = '0x' + '33'.repeat(20)
const FAST = { kdfOps: 1, kdfMem: 8 * 1024 * 1024 }
import fixtureJson from './fixtures/address-book-web.json'
const FIXTURE = fixtureJson as AddressBookFile

class MemoryStorage implements AddressBookStorage {
  current: AddressBookFile | null = null
  backup: AddressBookFile | null = null
  async load() {
    return this.current ? JSON.parse(JSON.stringify(this.current)) : null
  }
  async save(file: AddressBookFile) {
    this.current = JSON.parse(JSON.stringify(file))
  }
  async loadBackup() {
    return this.backup
  }
  async saveBackup(file: AddressBookFile) {
    this.backup = JSON.parse(JSON.stringify(file))
  }
  async clear() {
    this.current = null
    this.backup = null
  }
}

function service(): { storage: MemoryStorage; book: AddressBookService } {
  const storage = new MemoryStorage()
  return { storage, book: new AddressBookService(storage, FAST) }
}

describe('地址簿：web 格式兼容', () => {
  it('可以解密 web 导出的地址簿 fixture', async () => {
    const { book } = service()
    await book.importBlob(PASSWORD, FIXTURE)
    const rows = await book.unlock(PASSWORD)
    expect(rows.map((row) => row.address)).toEqual([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ])
    expect(rows[0].label).toBe('交易所')
    expect(rows[0].note).toBe('主账号')
    expect(book.status().count).toBe(2)
  })

  it('错误密码不覆盖当前地址簿', async () => {
    const { book } = service()
    await book.importBlob(PASSWORD, FIXTURE)
    const before = await book.exportBlob()
    await expect(
      new AddressBookService(new MemoryStorage(), FAST).importBlob('wrong password 123', FIXTURE),
    ).rejects.toThrow('地址簿密码错误')
    expect((await book.exportBlob()).entries.length).toBe(before.entries.length)
  })

  it('篡改密文会被认证拒绝', async () => {
    const bad = JSON.parse(JSON.stringify(FIXTURE)) as AddressBookFile
    const raw = atob(bad.entries[0].cipher.ciphertext)
    bad.entries[0].cipher.ciphertext = btoa(String.fromCharCode(raw.charCodeAt(0) ^ 1) + raw.slice(1))
    const { book } = service()
    await expect(book.importBlob(PASSWORD, bad)).rejects.toThrow()
  })
})

describe('地址簿：本地增删改查与导入导出', () => {
  it('创建、添加、修改、删除并保持 id 单调', async () => {
    const { book } = service()
    await book.create(PASSWORD, { address: ADDR1, label: 'A', note: 'n' })
    expect((await book.unlock(PASSWORD))[0].label).toBe('A')
    const second = await book.add(ADDR2, 'B')
    expect(second.id).toBe(2)
    await book.update(second.id, ADDR3, 'C', 'note')
    expect(book.entriesSnapshot[1].address).toBe('0x3333333333333333333333333333333333333333')
    await book.remove(second.id)
    expect(book.entriesSnapshot.map((row) => row.id)).toEqual([1])
    const third = await book.add(ADDR2, 'D')
    expect(third.id).toBe(3)
  })

  it('重复地址拒绝，且不区分大小写', async () => {
    const { book } = service()
    await book.create(PASSWORD, { address: ADDR1 })
    await expect(book.add(ADDR1.toUpperCase().replace('0X', '0x'))).rejects.toThrow('已经在地址本')
  })

  it('导出文件含 app/exported_at 且没有明文地址', async () => {
    const { book } = service()
    await book.create(PASSWORD, { address: ADDR1, label: '交易所' })
    const blob = await book.exportBlob()
    const text = JSON.stringify(blob)
    expect(blob.app).toBe('wallet-address-book-v1')
    expect(blob.exported_at).toBeTruthy()
    expect(text.toLowerCase()).not.toContain(ADDR1.toLowerCase())
    expect(text).not.toContain('交易所')
    expect(blob.meta.scheme).toBe('wallet-address-book-v1')
    expect(blob.entries).toHaveLength(1)
  })

  it('当前非空时导入需要 confirm，并保留旧密文备份', async () => {
    const { storage, book } = service()
    await book.create(PASSWORD, { address: ADDR1 })
    await expect(book.importBlob(PASSWORD, FIXTURE)).rejects.toThrow('确认覆盖')
    const result = await book.importBlob(PASSWORD, FIXTURE, true)
    expect(result.restored).toBe(2)
    expect(result.backup).toBe('local-backup')
    expect(storage.backup).not.toBeNull()
    expect(book.status().count).toBe(2)
  })

  it('锁定后清空内存条目，必须重新解锁', async () => {
    const { book } = service()
    await book.create(PASSWORD, { address: ADDR1 })
    book.lock()
    expect(book.isUnlocked()).toBe(false)
    await expect(book.add(ADDR2)).rejects.toThrow('请先解锁')
    await book.unlock(PASSWORD)
    expect(book.entriesSnapshot).toHaveLength(1)
  })
})
