import type { RpcEndpoint } from './rpc'

export interface NativeAsset {
  symbol: string
  name: string
  decimals: number
}

export interface ChainConfig {
  id: number
  name: string
  short: string
  rpc: RpcEndpoint[]
  native: NativeAsset
}

export const BSC: ChainConfig = {
  id: 56,
  name: 'BNB Smart Chain',
  short: 'BSC',
  native: { symbol: 'BNB', name: 'BNB', decimals: 18 },
  rpc: [
    { url: 'https://bsc-dataseed.binance.org', label: 'Binance' },
    { url: 'https://bsc-dataseed1.binance.org', label: 'Binance 1' },
    { url: 'https://bsc-rpc.publicnode.com', label: 'PublicNode' },
  ],
}

export const OP: ChainConfig = {
  id: 10,
  name: 'Optimism',
  short: 'OP',
  native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
  rpc: [
    { url: 'https://optimism-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://mainnet.optimism.io', label: 'OP Labs' },
  ],
}

export const CHAINS: ChainConfig[] = [BSC, OP]

