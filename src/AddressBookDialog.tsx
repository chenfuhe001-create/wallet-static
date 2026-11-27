import { useEffect, useMemo, useRef, useState } from 'react'
import { addressBookService } from './addressBook/client'
import {
  ADDRESS_BOOK_FINGERPRINT_SCOPE,
  clearFingerprint,
  enableFingerprint,
  hasFingerprint,
  isWebAuthnSupported,
  unlockWithFingerprint,
} from './crypto/fingerprint'
import type { AddressBookEntry } from './addressBook/types'

interface Props {
  mode?: 'manage' | 'pick'
  onClose: () => void
  onPick?: (entry: AddressBookEntry) => void
  onToast?: (message: string, type?: 'success' | 'error') => void
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** 地址簿弹层：密码只用于本地址簿，与钱包密码无关；关闭即清空内存。 */
export default function AddressBookDialog({ mode = 'manage', onClose, onPick, onToast }: Props) {
  const [initialized, setInitialized] = useState(false)
  const [count, setCount] = useState(0)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [entries, setEntries] = useState<AddressBookEntry[] | null>(null)
  const [keyword, setKeyword] = useState('')
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [importing, setImporting] = useState(false)
  const [fingerprintReady, setFingerprintReady] = useState(() =>
    hasFingerprint(ADDRESS_BOOK_FINGERPRINT_SCOPE),
  )
  const [webAuthnSupported] = useState(() => isWebAuthnSupported())
  const fileRef = useRef<HTMLInputElement>(null)

  const toast = (message: string, type: 'success' | 'error' = 'success') => {
    if (type === 'error') setError(message)
    else setNotice(message)
    onToast?.(message, type)
  }

  const refreshStatus = async () => {
    const status = await addressBookService.init()
    setInitialized(status.initialized)
    setCount(status.count)
  }

  useEffect(() => {
    void refreshStatus().catch((err) =>
      setError(err instanceof Error ? err.message : '读取地址簿失败'),
    )
    return () => {
      addressBookService.lock()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const unlocked = entries !== null

  const refreshEntries = () => {
    const rows = addressBookService.entriesSnapshot
    setEntries(rows)
    setCount(rows.length)
  }

  const createWithFirst = async () => {
    setError('')
    if (password.length < 12) {
      setError('地址本密码至少 12 位')
      return
    }
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    if (!address.trim()) {
      setError('请填写第一条常用地址')
      return
    }
    setBusy(true)
    try {
      await addressBookService.create(password, { address, label, note })
      refreshEntries()
      setAddress('')
      setLabel('')
      setNote('')
      setInitialized(true)
      clearFingerprint(ADDRESS_BOOK_FINGERPRINT_SCOPE)
      setFingerprintReady(false)
      toast('地址本已创建')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建地址本失败')
    } finally {
      setBusy(false)
    }
  }

  const unlock = async () => {
    setError('')
    if (!password) {
      setError('请输入地址本密码')
      return
    }
    setBusy(true)
    try {
      const rows = await addressBookService.unlock(password)
      setEntries(rows)
      setCount(rows.length)
      setConfirmPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '解锁地址本失败')
    } finally {
      setBusy(false)
    }
  }

  const unlockByFingerprint = async () => {
    setError('')
    setBusy(true)
    try {
      const secret = await unlockWithFingerprint(ADDRESS_BOOK_FINGERPRINT_SCOPE)
      const rows = await addressBookService.unlock(secret)
      setPassword(secret)
      setEntries(rows)
      setCount(rows.length)
      setConfirmPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '指纹解锁地址簿失败')
    } finally {
      setBusy(false)
    }
  }

  const enableBookFingerprint = async () => {
    setError('')
    if (!password) {
      setError('请先用密码解锁地址簿，再启用指纹')
      return
    }
    setBusy(true)
    try {
      await enableFingerprint(password, ADDRESS_BOOK_FINGERPRINT_SCOPE)
      setFingerprintReady(true)
      toast('地址簿指纹已启用（与钱包指纹分开保存）')
    } catch (err) {
      setError(err instanceof Error ? err.message : '启用地址簿指纹失败')
    } finally {
      setBusy(false)
    }
  }

  const disableBookFingerprint = () => {
    clearFingerprint(ADDRESS_BOOK_FINGERPRINT_SCOPE)
    setFingerprintReady(false)
    toast('已停用地址簿指纹；密码解锁仍可用')
  }

  const saveEntry = async () => {
    setError('')
    if (!address.trim()) {
      setError('请填写地址')
      return
    }
    setBusy(true)
    try {
      if (editingId === null) await addressBookService.add(address, label, note)
      else await addressBookService.update(editingId, address, label, note)
      refreshEntries()
      setAddress('')
      setLabel('')
      setNote('')
      setEditingId(null)
      toast(editingId === null ? '地址已加入地址本' : '地址已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存地址失败')
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (entry: AddressBookEntry) => {
    setEditingId(entry.id)
    setAddress(entry.address)
    setLabel(entry.label)
    setNote(entry.note)
    setError('')
  }

  const removeEntry = async (entry: AddressBookEntry) => {
    if (!window.confirm(`从地址本删除 #${entry.id} ${entry.label || short(entry.address)}？`)) return
    setBusy(true)
    setError('')
    try {
      await addressBookService.remove(entry.id)
      refreshEntries()
      if (editingId === entry.id) {
        setEditingId(null)
        setAddress('')
        setLabel('')
        setNote('')
      }
      toast('已从地址本删除')
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const exportBook = async () => {
    setError('')
    try {
      const blob = await addressBookService.exportBlob()
      downloadJson(`address-book-${new Date().toISOString().slice(0, 10)}.json`, blob)
      toast('地址本密文已导出；恢复时需要导出时的地址本密码')
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败')
    }
  }

  const importBook = async (file: File) => {
    setError('')
    setNotice('')
    if (file.size > 8 * 1024 * 1024) {
      setError('地址本备份不能超过 8MB')
      return
    }
    if (!password) {
      setError('请先输入备份文件的地址本密码，再导入')
      return
    }
    setImporting(true)
    try {
      const data = JSON.parse(await file.text())
      const hasEntries = count > 0
      if (hasEntries && !window.confirm('导入会整体覆盖当前地址簿（旧密文会先本地备份），确定继续？')) {
        return
      }
      const result = await addressBookService.importBlob(password, data, hasEntries)
      setEntries(addressBookService.entriesSnapshot)
      setCount(result.restored)
      setInitialized(true)
      setAddress('')
      setLabel('')
      setNote('')
      setEditingId(null)
      clearFingerprint(ADDRESS_BOOK_FINGERPRINT_SCOPE)
      setFingerprintReady(false)
      toast(`已恢复 ${result.restored} 条地址${result.backup ? '，旧地址簿已本地备份' : ''}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const lock = () => {
    addressBookService.lock()
    setEntries(null)
    setPassword('')
    setConfirmPassword('')
    setKeyword('')
    setEditingId(null)
    setAddress('')
    setLabel('')
    setNote('')
    setError('')
    setNotice('')
  }

  const close = () => {
    addressBookService.lock()
    onClose()
  }

  const filtered = useMemo(() => {
    const rows = entries ?? []
    const needle = keyword.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(
      (entry) =>
        entry.address.toLowerCase().includes(needle) ||
        entry.label.toLowerCase().includes(needle) ||
        entry.note.toLowerCase().includes(needle) ||
        String(entry.id).includes(needle),
    )
  }, [entries, keyword])

  const pick = (entry: AddressBookEntry) => {
    onPick?.(entry)
    close()
  }

  const copyAddress = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast('地址已复制')
    } catch {
      setError('复制失败，请手动选择地址')
    }
  }

  return (
    <div className="bookBackdrop" role="dialog" aria-modal="true">
      <div className="bookCard">
        <div className="row space">
          <div>
            <h2>{mode === 'pick' ? '从地址簿选择收款地址' : '地址簿'}</h2>
            <p className="small muted">
              {mode === 'pick'
                ? '点一条记录直接填入收款地址；地址簿密码和钱包密码互相独立。'
                : '常用收款地址的密文台账：独立密码，文件里没有明文地址。'}
            </p>
          </div>
          <button className="ghost" onClick={close} disabled={busy || importing}>
            关闭
          </button>
        </div>

        {!unlocked ? (
          initialized ? (
            <div className="row">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="地址本密码"
                autoComplete="current-password"
              />
              <button className="primary" onClick={() => void unlock()} disabled={busy || !password}>
                {busy ? '解锁中…' : '解锁地址本'}
              </button>
              <button className="ghost" onClick={() => void exportBook()}>
                导出密文
              </button>
              <button className="ghost" onClick={() => fileRef.current?.click()} disabled={importing}>
                {importing ? '导入中…' : '导入密文'}
              </button>
              {webAuthnSupported && fingerprintReady ? (
                <button className="primary" onClick={() => void unlockByFingerprint()} disabled={busy}>
                  用指纹解锁地址簿
                </button>
              ) : null}
            </div>
          ) : (
            <div>
              <p className="warn">
                地址本还没有创建。设置一个独立的地址本密码（至少 12 位，可与钱包密码不同），并添加第一条常用地址。
                密码丢失只能靠导出的密文备份 + 密码恢复。
              </p>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="地址本密码（至少 12 位）"
                autoComplete="new-password"
              />
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入地址本密码"
                autoComplete="new-password"
              />
              <AddressFields
                address={address}
                label={label}
                note={note}
                setAddress={setAddress}
                setLabel={setLabel}
                setNote={setNote}
              />
              <div className="row">
                <button className="primary" onClick={() => void createWithFirst()} disabled={busy}>
                  {busy ? '创建中…' : '创建并保存'}
                </button>
                <button className="ghost" onClick={() => fileRef.current?.click()} disabled={importing}>
                  {importing ? '导入中…' : '导入已有密文备份'}
                </button>
              </div>
            </div>
          )
        ) : (
          <div>
            <div className="row">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索标签 / 地址 / 备注"
              />
              <span className="small muted">
                {filtered.length}/{entries?.length ?? 0} 条
              </span>
              <button className="ghost" onClick={lock} disabled={busy}>
                锁定
              </button>
            </div>

            {filtered.length === 0 ? (
              <p className="small muted">地址本还是空的。</p>
            ) : (
              <div className="bookList">
                {filtered.map((entry) => (
                  <div key={entry.id} className="bookRow">
                    <div className="row space">
                      <span className="small">#{entry.id} {entry.label || '无标签'}</span>
                      <div className="row">
                        {mode === 'pick' ? (
                          <button className="primary" onClick={() => pick(entry)}>
                            用这个地址
                          </button>
                        ) : (
                          <>
                            <button className="ghost" onClick={() => startEdit(entry)} disabled={busy}>
                              编辑
                            </button>
                            <button className="danger" onClick={() => void removeEntry(entry)} disabled={busy}>
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      className="bookAddress mono small"
                      onClick={() => (mode === 'pick' ? pick(entry) : void copyAddress(entry.address))}
                    >
                      {entry.address}
                    </button>
                    {entry.note ? <div className="small muted">{entry.note}</div> : null}
                  </div>
                ))}
              </div>
            )}

            {mode === 'manage' ? (
              <div className="bookForm">
                <div className="row space">
                  <span className="small muted">{editingId === null ? '添加地址' : `编辑 #${editingId}`}</span>
                  {editingId !== null ? (
                    <button
                      className="ghost"
                      onClick={() => {
                        setEditingId(null)
                        setAddress('')
                        setLabel('')
                        setNote('')
                      }}
                    >
                      取消编辑
                    </button>
                  ) : null}
                </div>
                <AddressFields
                  address={address}
                  label={label}
                  note={note}
                  setAddress={setAddress}
                  setLabel={setLabel}
                  setNote={setNote}
                />
                <button className="primary" onClick={() => void saveEntry()} disabled={busy || !address.trim()}>
                  {busy ? '保存中…' : editingId === null ? '加入地址本' : '保存修改'}
                </button>
              </div>
            ) : null}

            <div className="row">
              <button className="ghost" onClick={() => void exportBook()}>
                导出密文
              </button>
              <button className="ghost" onClick={() => fileRef.current?.click()} disabled={importing}>
                {importing ? '导入中…' : '导入密文'}
              </button>
              {webAuthnSupported ? (
                fingerprintReady ? (
                  <button className="ghost" onClick={disableBookFingerprint} disabled={busy}>
                    停用地址簿指纹
                  </button>
                ) : (
                  <button
                    className="ghost"
                    onClick={() => void enableBookFingerprint()}
                    disabled={busy || !password}
                  >
                    启用地址簿指纹
                  </button>
                )
              ) : (
                <span className="small muted">当前环境不支持 WebAuthn/指纹</span>
              )}
              <span className="small muted">导出文件不含明文地址，恢复时需要地址本密码</span>
            </div>
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importBook(file)
            e.target.value = ''
          }}
        />
        {error ? <div className="error">{error}</div> : null}
        {notice ? <div className="notice">{notice}</div> : null}
      </div>
    </div>
  )
}

function AddressFields({
  address,
  label,
  note,
  setAddress,
  setLabel,
  setNote,
}: {
  address: string
  label: string
  note: string
  setAddress: (value: string) => void
  setLabel: (value: string) => void
  setNote: (value: string) => void
}) {
  return (
    <>
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="地址 0x…（保存前做 checksum 校验）"
        spellCheck={false}
      />
      <div className="row">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} placeholder="标签（如 交易所）" />
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="备注（可选）" />
      </div>
    </>
  )
}
