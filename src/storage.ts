/** 本地加密保险箱存储：IndexedDB 只存密文 JSON；明文密码/私钥不落盘。 */

import type { EncryptedVault } from './crypto/vault'

const DB_NAME = 'wallet-static'
const DB_VERSION = 1
const STORE = 'vault'
const KEY = 'current'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('无法打开本地数据库'))
  })
}

export async function loadStoredVault(): Promise<EncryptedVault | null> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve((req.result as EncryptedVault) ?? null)
      req.onerror = () => reject(req.error || new Error('读取本地保险箱失败'))
    })
  } finally {
    db.close()
  }
}

export async function saveStoredVault(data: EncryptedVault): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(data, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('保存本地保险箱失败'))
    })
  } finally {
    db.close()
  }
}

export async function clearStoredVault(): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('清除本地保险箱失败'))
    })
  } finally {
    db.close()
  }
}
