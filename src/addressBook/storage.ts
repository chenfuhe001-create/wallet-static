/** 地址簿密文存储：独立 IndexedDB，只存 {meta,entries} 密文文件。 */

import type { AddressBookFile } from './types'

export interface AddressBookStorage {
  load(): Promise<AddressBookFile | null>
  save(file: AddressBookFile): Promise<void>
  loadBackup(): Promise<AddressBookFile | null>
  saveBackup(file: AddressBookFile): Promise<void>
  clear(): Promise<void>
}

const DB_NAME = 'wallet-static-address-book'
const DB_VERSION = 1
const STORE = 'book'
const CURRENT = 'current'
const BACKUP = 'backup'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('无法打开地址簿数据库'))
  })
}

async function readKey(key: string): Promise<AddressBookFile | null> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as AddressBookFile) ?? null)
      req.onerror = () => reject(req.error || new Error('读取地址簿失败'))
    })
  } finally {
    db.close()
  }
}

async function writeKey(key: string, file: AddressBookFile): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(file, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('保存地址簿失败'))
    })
  } finally {
    db.close()
  }
}

export class IndexedDbAddressBookStorage implements AddressBookStorage {
  load(): Promise<AddressBookFile | null> {
    return readKey(CURRENT)
  }

  save(file: AddressBookFile): Promise<void> {
    return writeKey(CURRENT, file)
  }

  loadBackup(): Promise<AddressBookFile | null> {
    return readKey(BACKUP)
  }

  saveBackup(file: AddressBookFile): Promise<void> {
    return writeKey(BACKUP, file)
  }

  async clear(): Promise<void> {
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(CURRENT)
        tx.objectStore(STORE).delete(BACKUP)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error || new Error('清除地址簿失败'))
      })
    } finally {
      db.close()
    }
  }
}
