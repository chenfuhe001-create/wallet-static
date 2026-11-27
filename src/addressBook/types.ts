/** 地址簿文件类型：字段与 web/backend/wallet_book.py 的导出格式一一对应。 */

export interface AddressBookKdf {
  algo: string
  ops: number
  mem: number
  salt: string
}

export interface AddressBookCipher {
  scheme: string
  kdf: string
  salt: string
  nonce: string
  ciphertext: string
}

export interface AddressBookEntryRecord {
  id: number
  created_at: string
  updated_at: string
  cipher: AddressBookCipher
}

export interface AddressBookMeta {
  version: number
  scheme: string
  cipher: string
  next_id: number
  kdf: AddressBookKdf
  wrapNonce: string
  wrappedKey: string
  created_at: string
  updated_at: string
}

/** 存储/导出文件。导出时额外带 app/exported_at，导入时忽略这两个字段。 */
export interface AddressBookFile {
  meta: AddressBookMeta
  entries: AddressBookEntryRecord[]
  app?: string
  exported_at?: string
}

/** 解密后的公开条目，不含密码/密钥。 */
export interface AddressBookEntry {
  id: number
  address: string
  label: string
  note: string
  created_at: string | null
  updated_at: string | null
}

export interface AddressBookStatus {
  initialized: boolean
  count: number
  next_id: number
  scheme: string
  updated_at: string | null
}

export interface AddressBookImportResult {
  restored: number
  backup: string | null
  status: AddressBookStatus
}
