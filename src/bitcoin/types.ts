/** 比特币普通转账的最小类型集（主网 P2WPKH）。 */

export interface BitcoinUtxo {
  txid: string
  vout: number
  value: bigint
  confirmed: boolean
}

export interface BitcoinBalance {
  confirmed: bigint
  unconfirmed: bigint
  total: bigint
}

export interface BitcoinFeeRates {
  fast: number
  normal: number
  slow: number
}

export interface BitcoinTxStatus {
  confirmed: boolean
  blockHeight?: number
}

export interface BitcoinSendResult {
  txid: string
  status: 'broadcast' | 'pending' | 'confirmed'
  feeSats: bigint
  vsize: number
  changeSats: bigint
  inputCount: number
}

export interface BitcoinBuildResult extends BitcoinSendResult {
  hex: string
}
