import { parseUnits } from 'viem'
import type { RpcEndpoint } from './rpc'

export interface NativeAsset {
  symbol: string
  name: string
  decimals: number
}

export interface TokenAsset {
  symbol: string
  address: `0x${string}`
  decimals: number
}

export interface ChainConfig {
  /** 稳定的选择键，出现在 UI 与日志里；不随 chainId 重排变化。 */
  key: string
  id: number
  name: string
  short: string
  rpc: RpcEndpoint[]
  native: NativeAsset
}

export const BSC: ChainConfig = {
  key: 'bsc',
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
  /** 付 gas 的代币固定是 USDC；转账资产从 assets 里选，不能由前端传地址。 */
  feeToken: TokenAsset
  assets: TokenAsset[]
  feeCapUsdc: string
  firstFeeCapUsdc: string
  explorerTx: string
}

// Circle Paymaster v0.8 全套固定地址；新链只换 chainId/RPC/bundler/资产。
const PAYMASTER = '0x0578cFB241215b77442a541325d6A4E6dFE700Ec' as const
const ENTRYPOINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as const
const IMPLEMENTATION = '0xe6Cae83BdE06E4c305530e199D7217f42808555B' as const

function usdc(address: `0x${string}`): TokenAsset {
  return { symbol: 'USDC', address, decimals: 6 }
}

function asset(symbol: 'USDT0' | 'USDT', address: `0x${string}`): TokenAsset {
  return { symbol, address, decimals: 6 }
}

/** 地址来源：Circle USDC 官方表 + Tether USDT/USDT0 官方表，与服务器 wallet_chains.py 一致。 */
export const OP: AaChainConfig = {
  key: 'optimism',
  id: 10,
  name: 'Optimism',
  short: 'OP',
  native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
  rpc: [
    { url: 'https://optimism-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://mainnet.optimism.io', label: 'OP Labs' },
  ],
  aa: true,
  paymaster: PAYMASTER,
  entrypoint: ENTRYPOINT,
  implementation: IMPLEMENTATION,
  bundler: 'https://public.pimlico.io/v2/10/rpc',
  feeToken: usdc('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
  assets: [
    usdc('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
    asset('USDT0', '0x01bFF41798a0BcF287b996046Ca68b395DbC1071'),
    asset('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'),
  ],
  feeCapUsdc: '0.05',
  firstFeeCapUsdc: '0.10',
  explorerTx: 'https://optimistic.etherscan.io/tx/',
}

export const BASE: AaChainConfig = {
  key: 'base',
  id: 8453,
  name: 'Base',
  short: 'BASE',
  native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
  rpc: [
    { url: 'https://base-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://mainnet.base.org', label: 'Base' },
  ],
  aa: true,
  paymaster: PAYMASTER,
  entrypoint: ENTRYPOINT,
  implementation: IMPLEMENTATION,
  bundler: 'https://public.pimlico.io/v2/8453/rpc',
  feeToken: usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  assets: [
    usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    asset('USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'),
  ],
  feeCapUsdc: '0.10',
  firstFeeCapUsdc: '0.20',
  explorerTx: 'https://basescan.org/tx/',
}

export const ARBITRUM: AaChainConfig = {
  key: 'arbitrum',
  id: 42161,
  name: 'Arbitrum One',
  short: 'ARB',
  native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
  rpc: [
    { url: 'https://arbitrum-one-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://arb1.arbitrum.io/rpc', label: 'Arbitrum' },
  ],
  aa: true,
  paymaster: PAYMASTER,
  entrypoint: ENTRYPOINT,
  implementation: IMPLEMENTATION,
  bundler: 'https://public.pimlico.io/v2/42161/rpc',
  feeToken: usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
  assets: [
    usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
    asset('USDT0', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'),
  ],
  feeCapUsdc: '0.10',
  firstFeeCapUsdc: '0.20',
  explorerTx: 'https://arbiscan.io/tx/',
}

export const ETHEREUM: AaChainConfig = {
  key: 'ethereum',
  id: 1,
  name: 'Ethereum',
  short: 'ETH',
  native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
  rpc: [
    { url: 'https://ethereum-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://eth.drpc.org', label: 'dRPC' },
    { url: 'https://cloudflare-eth.com', label: 'Cloudflare' },
  ],
  aa: true,
  paymaster: PAYMASTER,
  entrypoint: ENTRYPOINT,
  implementation: IMPLEMENTATION,
  bundler: 'https://public.pimlico.io/v2/1/rpc',
  feeToken: usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  assets: [
    usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    asset('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7'),
  ],
  feeCapUsdc: '0.50',
  firstFeeCapUsdc: '1.00',
  explorerTx: 'https://etherscan.io/tx/',
}

export const POLYGON: AaChainConfig = {
  key: 'polygon',
  id: 137,
  name: 'Polygon',
  short: 'POL',
  native: { symbol: 'POL', name: 'POL', decimals: 18 },
  rpc: [
    { url: 'https://polygon-bor-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://polygon-rpc.com', label: 'Polygon' },
  ],
  aa: true,
  paymaster: PAYMASTER,
  entrypoint: ENTRYPOINT,
  implementation: IMPLEMENTATION,
  bundler: 'https://public.pimlico.io/v2/137/rpc',
  feeToken: usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
  assets: [
    usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
    asset('USDT0', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'),
  ],
  feeCapUsdc: '0.10',
  firstFeeCapUsdc: '0.20',
  explorerTx: 'https://polygonscan.com/tx/',
}

export const AVALANCHE: AaChainConfig = {
  key: 'avalanche',
  id: 43114,
  name: 'Avalanche',
  short: 'AVAX',
  native: { symbol: 'AVAX', name: 'Avalanche', decimals: 18 },
  rpc: [
    { url: 'https://avalanche-c-chain-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://api.avax.network/ext/bc/C/rpc', label: 'Avalanche' },
  ],
  aa: true,
  paymaster: PAYMASTER,
  entrypoint: ENTRYPOINT,
  implementation: IMPLEMENTATION,
  bundler: 'https://public.pimlico.io/v2/43114/rpc',
  feeToken: usdc('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
  assets: [
    usdc('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
    asset('USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'),
  ],
  feeCapUsdc: '0.10',
  firstFeeCapUsdc: '0.20',
  explorerTx: 'https://snowtrace.io/tx/',
}

export const UNICHAIN: AaChainConfig = {
  key: 'unichain',
  id: 130,
  name: 'Unichain',
  short: 'UNI',
  native: { symbol: 'ETH', name: 'Ether', decimals: 18 },
  rpc: [
    { url: 'https://unichain-rpc.publicnode.com', label: 'PublicNode' },
    { url: 'https://mainnet.unichain.org', label: 'Unichain' },
  ],
  aa: true,
  paymaster: PAYMASTER,
  entrypoint: ENTRYPOINT,
  implementation: IMPLEMENTATION,
  bundler: 'https://public.pimlico.io/v2/130/rpc',
  feeToken: usdc('0x078D782b760474a361dDA0AF3839290b0EF57AD6'),
  assets: [
    usdc('0x078D782b760474a361dDA0AF3839290b0EF57AD6'),
    asset('USDT0', '0x9151434b16b9763660705744891fA906F660EcC5'),
  ],
  feeCapUsdc: '0.10',
  firstFeeCapUsdc: '0.20',
  explorerTx: 'https://uniscan.xyz/tx/',
}

export const AA_CHAINS: AaChainConfig[] = [
  OP,
  BASE,
  ARBITRUM,
  ETHEREUM,
  POLYGON,
  AVALANCHE,
  UNICHAIN,
]

export const CHAINS: ChainConfig[] = [BSC, ...AA_CHAINS]

export function getChain(id: number): ChainConfig | undefined {
  return CHAINS.find((chain) => chain.id === id)
}

/** AA 路径只认注册表里的链；BSC 走 legacy，不能混用。 */
export function getAaChain(id: number): AaChainConfig {
  if (id === BSC.id) throw new Error('BSC 是 legacy 链，不能走 Circle AA 路径')
  const chain = AA_CHAINS.find((item) => item.id === id)
  if (!chain) throw new Error(`不支持的链：${id}`)
  return chain
}

export function feeCapFor(chain: AaChainConfig, firstActivation: boolean): bigint {
  return parseUnits(firstActivation ? chain.firstFeeCapUsdc : chain.feeCapUsdc, 6)
}

/** 转账资产只从注册表取；未登记资产直接拒绝，不接受前端传地址。 */
export function getAsset(chain: AaChainConfig, symbol: string): TokenAsset {
  const wanted = symbol.trim().toUpperCase()
  const found = chain.assets.find((item) => item.symbol.toUpperCase() === wanted)
  if (!found) throw new Error(`${chain.name} 未登记资产 ${symbol}`)
  return found
}
