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

export interface AaChainConfig extends ChainConfig {
  aa: true
  paymaster: `0x${string}`
  entrypoint: `0x${string}`
  implementation: `0x${string}`
  bundler: string
  usdc: `0x${string}`
  usdt?: `0x${string}`
  usdt0?: `0x${string}`
  feeCapUsdc: string
  firstFeeCapUsdc: string
  explorerTx: string
}

export const OP: AaChainConfig = {
  id: 10,
  name: 'Optimism',
  short: 'OP',
  native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
  rpc: [
    { url: 'https://optimism-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://mainnet.optimism.io', label: 'OP Labs' },
  ],
  aa: true,
  paymaster: '0x0578cFB241215b77442a541325d6A4E6dFE700Ec',
  entrypoint: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
  implementation: '0xe6Cae83BdE06E4c305530e199D7217f42808555B',
  bundler: 'https://public.pimlico.io/v2/10/rpc',
  usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  usdt: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  usdt0: '0x01bFF41798a0BcF287b996046Ca68b395DbC1071',
  feeCapUsdc: '0.05',
  firstFeeCapUsdc: '0.10',
  explorerTx: 'https://optimistic.etherscan.io/tx/',
}

export const CHAINS: ChainConfig[] = [BSC, OP]

