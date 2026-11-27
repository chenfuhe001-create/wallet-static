import { AddressBookService } from './service'
import { IndexedDbAddressBookStorage } from './storage'

/** 全页共享一个地址簿服务；密码解锁后的 DataKey 只在内存，关闭弹层即清零。 */
export const addressBookService = new AddressBookService(new IndexedDbAddressBookStorage())
