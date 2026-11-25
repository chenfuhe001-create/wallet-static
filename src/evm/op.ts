/**
 * Circle Paymaster v0.8 + EIP-7702 的本地 AA 实现（多链参数化）。
 *
 * 所有签名（permit / UserOp / 7702 授权）都在浏览器完成；bundler 只接收
 * 已签名的 UserOp，无法改收款地址/金额。服务器完全不参与。
 *
 * 链、资产、Paymaster/EntryPoint/7702 实现地址、费用上限全部来自
 * `chains.ts` 注册表；本模块不接受任意合约地址参数。
 */

import {
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  formatUnits,
  hexToBigInt,
  isAddress,
  keccak256,
  numberToHex,
  parseUnits,
  stringToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { feeCapFor, getAsset } from '../chains'
import type { AaChainConfig, TokenAsset } from '../chains'
import {
  AmbiguousBroadcastError,
  PreBroadcastError,
  isTransientNetworkError,
  rpcCall,
  rpcRead,
  sleep,
  type RpcEndpoint,
} from '../rpc'

const USEROP_TYPEHASH = keccak256(
  stringToHex(
    'PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)',
  ),
)
const DOMAIN_TYPEHASH = keccak256(
  stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
)
const ERC4337_NAME_HASH = keccak256(stringToHex('ERC4337'))
const ERC4337_VERSION_HASH = keccak256(stringToHex('1'))
const TRANSFER_SELECTOR = keccak256(stringToHex('transfer(address,uint256)')).slice(0, 10) as Hex
const EXECUTE_SELECTOR = keccak256(stringToHex('execute(address,uint256,bytes)')).slice(0, 10) as Hex
const BALANCE_OF_SELECTOR = keccak256(stringToHex('balanceOf(address)')).slice(0, 10) as Hex
const NONCES_SELECTOR = keccak256(stringToHex('nonces(address)')).slice(0, 10) as Hex
const NAME_SELECTOR = keccak256(stringToHex('name()')).slice(0, 10) as Hex
const VERSION_SELECTOR = keccak256(stringToHex('version()')).slice(0, 10) as Hex
const GET_NONCE_SELECTOR = keccak256(stringToHex('getNonce(address,uint192)')).slice(0, 10) as Hex
const FETCH_PRICE_SELECTOR = keccak256(stringToHex('fetchPrice()')).slice(0, 10) as Hex
const FEE_SPREAD_SELECTOR = keccak256(stringToHex('feeSpread()')).slice(0, 10) as Hex
const ADDITIONAL_GAS_SELECTOR = keccak256(stringToHex('additionalGasCharge()')).slice(0, 10) as Hex

const USEROP_SPONSORED_TOPIC = keccak256(
  stringToHex('UserOperationSponsored(address,address,bytes32,uint256,uint256,uint256)'),
)

const STUB_SIGNATURE: Hex =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c'
const MAX_UINT256 = (1n << 256n) - 1n

function bundlerEndpoint(chain: AaChainConfig): RpcEndpoint {
  return { url: chain.bundler, label: 'Pimlico' }
}

// 公共 Pimlico 约 12 次/分钟就会触发 WAF，随后约 30 秒内全是 Failed to fetch。
// 所有 bundler 请求走同一队列，6 秒一次；9 笔批量约 4 分钟，宁可慢也不能断。
const BUNDLER_MIN_INTERVAL_MS = 6_000
let bundlerQueue: Promise<unknown> = Promise.resolve()
let lastBundlerCallAt = 0

async function bundlerCall<T>(
  chain: AaChainConfig,
  method: string,
  params: unknown[] = [],
  timeoutMs = 30_000,
): Promise<T> {
  const run = async () => {
    const wait = Math.max(0, BUNDLER_MIN_INTERVAL_MS - (Date.now() - lastBundlerCallAt))
    if (wait > 0) await sleep(wait)
    lastBundlerCallAt = Date.now()
    return rpcCall<T>(bundlerEndpoint(chain), method, params, timeoutMs)
  }
  const result = bundlerQueue.then(run, run)
  bundlerQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function withTransientRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  // 公共 Pimlico 的 WAF 通常封 30 秒；退避总时长要覆盖一次冷却。
  const delays = [5_000, 12_000, 25_000]
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (!isTransientNetworkError(err) || attempt === attempts - 1) throw err
      await sleep(delays[Math.min(attempt, delays.length - 1)])
    }
  }
  throw last
}

export interface AaDelegation {
  status: 'none' | 'delegated' | 'contract' | 'unknown'
  implementation?: string
  codeLength: number
}

export interface AaAssetBalance {
  symbol: string
  address: string
  balance: string
}

export interface AaOverview {
  address: string
  native: string
  assets: AaAssetBalance[]
  delegation: AaDelegation
}

export interface AaTransferInput {
  privateKey: Hex
  to: string
  amount: string
  /** 资产符号，只认链注册表里登记过的资产。 */
  asset: string
}

export interface AaTransferResult {
  userOpHash: Hex
  txHash?: Hex
  status: 'success' | 'failed' | 'pending'
  feeUsdc?: string
  explorer: string
}

function hx(value: bigint | number): Hex {
  return numberToHex(value, { size: 32 })
}

export function pack128(a: bigint | number, b: bigint | number): Hex {
  return hx((BigInt(a) << 128n) | BigInt(b))
}

export function encodeErc20Transfer(to: string, amount: bigint): Hex {
  return concat([
    TRANSFER_SELECTOR,
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to as Hex, amount]),
  ])
}

export function encodeExecute(target: string, value: bigint, data: Hex): Hex {
  return concat([
    EXECUTE_SELECTOR,
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
      [target as Hex, value, data],
    ),
  ])
}

export function packPaymasterAndData(paymaster: string, verification: bigint, postOp: bigint, data: Hex): Hex {
  return concat([
    paymaster as Hex,
    numberToHex(verification, { size: 16 }),
    numberToHex(postOp, { size: 16 }),
    data,
  ])
}

export function packPaymasterData(token: string, permitAmount: bigint, signature: Hex): Hex {
  return concat(['0x00', token as Hex, hx(permitAmount), signature])
}

function readStringResult(raw: Hex): string {
  try {
    return decodeAbiParameters([{ type: 'string' }], raw)[0]
  } catch {
    throw new Error('代币 name/version 不可读')
  }
}

async function readUint(chain: AaChainConfig, to: string, data: Hex): Promise<bigint> {
  const raw = await rpcRead<Hex>(chain.rpc, 'eth_call', [{ to, data }, 'latest'])
  return hexToBigInt(raw)
}

async function readTokenString(chain: AaChainConfig, token: string, selector: Hex): Promise<string> {
  const raw = await rpcRead<Hex>(chain.rpc, 'eth_call', [{ to: token, data: selector }, 'latest'])
  return readStringResult(raw)
}

async function readTokenBalance(chain: AaChainConfig, token: TokenAsset, owner: string): Promise<bigint> {
  return readUint(
    chain,
    token.address,
    concat([BALANCE_OF_SELECTOR, encodeAbiParameters([{ type: 'address' }], [owner as Hex])]),
  )
}

export async function getDelegation(chain: AaChainConfig, address: string): Promise<AaDelegation> {
  const code = await rpcRead<Hex>(chain.rpc, 'eth_getCode', [address, 'latest'])
  if (!code || code === '0x') return { status: 'none', codeLength: 0 }
  if (code.length === 48 && code.startsWith('0xef0100')) {
    return {
      status: 'delegated',
      implementation: `0x${code.slice(8)}`,
      codeLength: 23,
    }
  }
  return { status: 'contract', codeLength: (code.length - 2) / 2 }
}

export async function getAaOverview(chain: AaChainConfig, address: string): Promise<AaOverview> {
  if (!isAddress(address)) throw new Error('地址格式不正确')
  const [nativeRaw, delegation, ...tokenBalances] = await Promise.all([
    rpcRead<Hex>(chain.rpc, 'eth_getBalance', [address, 'latest']),
    getDelegation(chain, address),
    ...chain.assets.map((asset) => readTokenBalance(chain, asset, address)),
  ])
  return {
    address,
    native: formatUnits(hexToBigInt(nativeRaw), chain.native.decimals),
    assets: chain.assets.map((asset, index) => ({
      symbol: asset.symbol,
      address: asset.address,
      balance: formatUnits(tokenBalances[index] ?? 0n, asset.decimals),
    })),
    delegation,
  }
}

const gasPriceCache = new Map<
  number,
  { at: number; value: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } }
>()
const GAS_PRICE_TTL_MS = 15_000

export async function getBundlerGasPrice(
  chain: AaChainConfig,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const cached = gasPriceCache.get(chain.id)
  if (cached && Date.now() - cached.at < GAS_PRICE_TTL_MS) return cached.value
  try {
    const result = await bundlerCall<{
      standard?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
      fast?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
      slow?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
    }>(chain, 'pimlico_getUserOperationGasPrice', [], 30_000)
    const bucket = result.standard || result.fast || result.slow
    if (bucket) {
      const maxFeePerGas = hexToBigInt(bucket.maxFeePerGas)
      const maxPriorityFeePerGas = hexToBigInt(bucket.maxPriorityFeePerGas)
      if (maxFeePerGas > 0n) {
        const value = { maxFeePerGas, maxPriorityFeePerGas }
        gasPriceCache.set(chain.id, { at: Date.now(), value })
        return value
      }
    }
  } catch {
    /* fallback */
  }
  const gasPrice = hexToBigInt(await rpcRead<Hex>(chain.rpc, 'eth_gasPrice', []))
  if (gasPrice <= 0n) throw new Error(`无法获取 ${chain.short} gasPrice`)
  const value = {
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice < 1_000_000_000n ? gasPrice : 1_000_000_000n,
  }
  gasPriceCache.set(chain.id, { at: Date.now(), value })
  return value
}

interface PaymasterState {
  nativeTokenPrice: bigint
  feeSpreadBips: bigint
  additionalGasCharge: bigint
}

const paymasterCache = new Map<number, { at: number; value: PaymasterState }>()
const PAYMASTER_TTL_MS = 30_000

export async function getPaymasterState(chain: AaChainConfig): Promise<PaymasterState> {
  const cached = paymasterCache.get(chain.id)
  if (cached && Date.now() - cached.at < PAYMASTER_TTL_MS) return cached.value
  const [price, spread, additional] = await Promise.all([
    readUint(chain, chain.paymaster, FETCH_PRICE_SELECTOR),
    readUint(chain, chain.paymaster, FEE_SPREAD_SELECTOR),
    readUint(chain, chain.paymaster, ADDITIONAL_GAS_SELECTOR),
  ])
  if (price <= 0n) throw new Error('Circle Paymaster 价格预言机不可读')
  const value = {
    nativeTokenPrice: price,
    feeSpreadBips: spread > 1000n ? spread : 1000n,
    additionalGasCharge: additional > 0n ? additional : 35_000n,
  }
  paymasterCache.set(chain.id, { at: Date.now(), value })
  return value
}

function estimatePrefund(input: {
  nativeTokenPrice: bigint
  additionalGasCharge: bigint
  maxFeePerGas: bigint
  totalGas: bigint
  feeSpreadBips: bigint
  nativeDecimals: number
}): bigint {
  const gasCost = (input.totalGas + input.additionalGasCharge) * input.maxFeePerGas
  const base = (gasCost * input.nativeTokenPrice) / 10n ** BigInt(input.nativeDecimals) + 1n
  const spread = (base * input.feeSpreadBips) / 10_000n
  return base + spread
}

async function getEntryPointNonce(chain: AaChainConfig, sender: string): Promise<bigint> {
  const data = concat([
    GET_NONCE_SELECTOR,
    encodeAbiParameters([{ type: 'address' }, { type: 'uint192' }], [sender as Hex, 0n]),
  ])
  return readUint(chain, chain.entrypoint, data)
}

async function getPermitNonce(chain: AaChainConfig, owner: string): Promise<bigint> {
  return readUint(
    chain,
    chain.feeToken.address,
    concat([NONCES_SELECTOR, encodeAbiParameters([{ type: 'address' }], [owner as Hex])]),
  )
}

export function computeUserOpHash(
  input: {
    sender: string
    nonce: bigint
    initCode: Hex
    callData: Hex
    accountGasLimits: Hex
    preVerificationGas: bigint
    gasFees: Hex
    paymasterAndData: Hex
    delegate?: string
    factoryData?: Hex
  },
  chain: AaChainConfig,
): Hex {
  const hashInit = input.delegate
    ? keccak256(concat([input.delegate as Hex, input.factoryData || '0x']))
    : keccak256(input.initCode)
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        USEROP_TYPEHASH,
        input.sender as Hex,
        input.nonce,
        hashInit,
        keccak256(input.callData),
        input.accountGasLimits,
        input.preVerificationGas,
        input.gasFees,
        keccak256(input.paymasterAndData),
      ],
    ),
  )
  const domain = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [DOMAIN_TYPEHASH, ERC4337_NAME_HASH, ERC4337_VERSION_HASH, BigInt(chain.id), chain.entrypoint as Hex],
    ),
  )
  return keccak256(concat(['0x1901', domain, structHash]))
}

interface UserOpJson {
  sender: string
  nonce: Hex
  callData: Hex
  callGasLimit: Hex
  verificationGasLimit: Hex
  preVerificationGas: Hex
  maxFeePerGas: Hex
  maxPriorityFeePerGas: Hex
  paymaster: string
  paymasterData: Hex
  paymasterVerificationGasLimit: Hex
  paymasterPostOpGasLimit: Hex
  signature: Hex
  factory?: '0x7702'
  factoryData?: Hex
  eip7702Auth?: Record<string, string>
}

function buildUserOp(
  chain: AaChainConfig,
  input: {
    sender: string
    nonce: bigint
    callData: Hex
    verificationGas: bigint
    callGas: bigint
    preVerificationGas: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    paymasterData: Hex
    paymasterVerificationGas: bigint
    paymasterPostOpGas: bigint
    signature: Hex
    authorization?: Record<string, string>
  },
): UserOpJson {
  const op: UserOpJson = {
    sender: input.sender,
    nonce: hx(input.nonce),
    callData: input.callData,
    callGasLimit: hx(input.callGas),
    verificationGasLimit: hx(input.verificationGas),
    preVerificationGas: hx(input.preVerificationGas),
    maxFeePerGas: hx(input.maxFeePerGas),
    maxPriorityFeePerGas: hx(input.maxPriorityFeePerGas),
    paymaster: chain.paymaster,
    paymasterData: input.paymasterData,
    paymasterVerificationGasLimit: hx(input.paymasterVerificationGas),
    paymasterPostOpGasLimit: hx(input.paymasterPostOpGas),
    signature: input.signature,
  }
  if (input.authorization) {
    op.factory = '0x7702'
    op.factoryData = '0x'
    op.eip7702Auth = input.authorization
  }
  return op
}

async function signAuthorization(
  chain: AaChainConfig,
  account: ReturnType<typeof privateKeyToAccount>,
  nonce: bigint,
) {
  const signed = await account.signAuthorization({
    chainId: chain.id,
    address: chain.implementation,
    nonce: Number(nonce),
  })
  return {
    address: chain.implementation,
    chainId: `0x${chain.id.toString(16)}`,
    nonce: `0x${nonce.toString(16)}`,
    yParity: `0x${Number(signed.yParity).toString(16)}`,
    r: signed.r,
    s: signed.s,
  }
}

async function estimateUserOpGas(chain: AaChainConfig, op: UserOpJson): Promise<Record<string, bigint>> {
  const result = await withTransientRetry(
    () =>
      bundlerCall<Record<string, string>>(
        chain,
        'eth_estimateUserOperationGas',
        [op, chain.entrypoint],
        45_000,
      ),
    3,
  )
  const out: Record<string, bigint> = {}
  for (const field of [
    'verificationGasLimit',
    'callGasLimit',
    'preVerificationGas',
    'paymasterVerificationGasLimit',
    'paymasterPostOpGasLimit',
  ]) {
    const raw = result[field]
    if (raw) out[field] = hexToBigInt(raw as Hex)
  }
  for (const required of ['verificationGasLimit', 'callGasLimit', 'preVerificationGas']) {
    if (!out[required] || out[required] <= 0n) throw new Error(`bundler 未返回 ${required}`)
  }
  return out
}

export async function waitForUserOpReceipt(
  chain: AaChainConfig,
  hash: Hex,
  timeoutMs = 120_000,
  pollMs = 5_000,
): Promise<AaTransferResult | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await bundlerCall<{
        success?: boolean
        actualGasCost?: Hex
        logs?: Array<{ address?: string; topics?: string[]; data?: Hex }>
        receipt?: {
          transactionHash?: Hex
          status?: Hex
          logs?: Array<{ address?: string; topics?: string[]; data?: Hex }>
        }
      } | null>(chain, 'eth_getUserOperationReceipt', [hash], 30_000)
      if (receipt) {
        const txHash = receipt.receipt?.transactionHash
        let feeUsdc: string | undefined
        // Circle 实际手续费只看 UserOperationSponsored 的 feeTokenAmount；
        // actualGasCost 是 native wei，不能当 USDC。
        for (const log of receipt.logs || receipt.receipt?.logs || []) {
          if (String(log.address || '').toLowerCase() !== chain.paymaster.toLowerCase()) continue
          if (!log.topics?.length || log.topics[0].toLowerCase() !== USEROP_SPONSORED_TOPIC.toLowerCase()) continue
          if (
            log.topics.length < 3 ||
            !log.topics[1].toLowerCase().endsWith(chain.feeToken.address.slice(2).toLowerCase())
          ) {
            continue
          }
          try {
            const words = decodeAbiParameters(
              [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
              (log.data || '0x') as Hex,
            )
            feeUsdc = formatUnits(words[2], 6)
            break
          } catch {
            /* 非标准日志忽略 */
          }
        }
        const innerStatus = receipt.receipt?.status
        const success = innerStatus !== undefined ? innerStatus === '0x1' : receipt.success !== false
        return {
          userOpHash: hash,
          txHash,
          status: success ? 'success' : 'failed',
          feeUsdc,
          explorer: txHash ? `${chain.explorerTx}${txHash}` : chain.explorerTx,
        }
      }
    } catch {
      /* bundler 限流/网络抖动时继续等 */
    }
    await sleep(pollMs)
  }
  return null
}

/**
 * 用本地私钥发一笔 AA 转账（gas 由 Circle Paymaster 以 USDC 支付）。
 * 流程与服务器 wallet_aa 同口径，但私钥/签名不离开浏览器。
 */
export async function sendAaTransfer(
  chain: AaChainConfig,
  input: AaTransferInput,
): Promise<AaTransferResult> {
  let broadcastStarted = false
  try {
  if (!isAddress(input.to)) throw new Error('收款地址格式不正确')
  const token = getAsset(chain, input.asset)
  const amount = parseUnits(input.amount || '0', token.decimals)
  if (amount <= 0n) throw new Error('金额必须大于 0')

  const account = privateKeyToAccount(input.privateKey)
  const sender = account.address
  const chainId = hexToBigInt(await rpcRead<Hex>(chain.rpc, 'eth_chainId', []))
  if (chainId !== BigInt(chain.id)) throw new Error(`RPC chainId=${chainId}，不是 ${chain.short}(${chain.id})`)

  const delegation = await getDelegation(chain, sender)
  if (delegation.status === 'contract') throw new Error('发送地址是合约，无法用 7702 钱包')
  if (
    delegation.status === 'delegated' &&
    delegation.implementation?.toLowerCase() !== chain.implementation.toLowerCase()
  ) {
    throw new Error(`该地址已委托到其他 7702 实现：${delegation.implementation}`)
  }
  const firstActivation = delegation.status === 'none'

  const cap = feeCapFor(chain, firstActivation)
  const [feeBalance, assetBalance] = await Promise.all([
    readTokenBalance(chain, chain.feeToken, sender),
    token.address.toLowerCase() === chain.feeToken.address.toLowerCase()
      ? Promise.resolve(0n)
      : readTokenBalance(chain, token, sender),
  ])
  const feeTokenIsAsset = token.address.toLowerCase() === chain.feeToken.address.toLowerCase()
  if (feeTokenIsAsset ? feeBalance < amount + cap : feeBalance < cap) {
    throw new Error(`${chain.feeToken.symbol} 余额不足以支付手续费上限`)
  }
  if (!feeTokenIsAsset && assetBalance < amount) throw new Error(`${token.symbol} 余额不足`)

  const [entrypointNonce, fee, tokenName, tokenVersion, permitNonce] = await Promise.all([
    getEntryPointNonce(chain, sender),
    getBundlerGasPrice(chain),
    readTokenString(chain, chain.feeToken.address, NAME_SELECTOR),
    readTokenString(chain, chain.feeToken.address, VERSION_SELECTOR),
    getPermitNonce(chain, sender),
  ])

  let authorization: Record<string, string> | undefined
  if (firstActivation) {
    const txCount = hexToBigInt(
      await rpcRead<Hex>(chain.rpc, 'eth_getTransactionCount', [sender, 'pending']),
    )
    authorization = await signAuthorization(chain, account, txCount)
  }

  // EIP-2612 permit：spender = Circle Paymaster，额度 = 本链手续费上限（USDC）
  const permitSignature = await account.signTypedData({
    domain: {
      name: tokenName,
      version: tokenVersion,
      chainId: chain.id,
      verifyingContract: chain.feeToken.address,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: sender,
      spender: chain.paymaster,
      value: cap,
      nonce: permitNonce,
      deadline: MAX_UINT256,
    },
  })

  const pmData = packPaymasterData(chain.feeToken.address, cap, permitSignature)
  const callData = encodeExecute(token.address, 0n, encodeErc20Transfer(input.to, amount))

  const estimateOp = buildUserOp(chain, {
    sender,
    nonce: entrypointNonce,
    callData,
    verificationGas: 1_000_000n,
    callGas: 300_000n,
    preVerificationGas: 120_000n,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    paymasterData: pmData,
    paymasterVerificationGas: 300_000n,
    paymasterPostOpGas: 80_000n,
    signature: STUB_SIGNATURE,
    authorization,
  })
  const est = await estimateUserOpGas(chain, estimateOp)
  const verificationGas = est.verificationGasLimit
  const callGas = est.callGasLimit
  const preVerificationGas = est.preVerificationGas
  const paymasterVerificationGas =
    est.paymasterVerificationGasLimit && est.paymasterVerificationGasLimit > 200_000n
      ? est.paymasterVerificationGasLimit
      : 200_000n
  const paymasterPostOpGas =
    est.paymasterPostOpGasLimit && est.paymasterPostOpGasLimit > 50_000n
      ? est.paymasterPostOpGasLimit
      : 50_000n
  const totalGas =
    verificationGas + callGas + preVerificationGas + paymasterVerificationGas + paymasterPostOpGas

  const pm = await getPaymasterState(chain)
  const prefund = estimatePrefund({
    nativeTokenPrice: pm.nativeTokenPrice,
    additionalGasCharge: pm.additionalGasCharge,
    maxFeePerGas: fee.maxFeePerGas,
    totalGas,
    feeSpreadBips: pm.feeSpreadBips,
    nativeDecimals: chain.native.decimals,
  })
  if (prefund > cap) {
    throw new Error(`预计手续费 ${formatUnits(prefund, 6)} USDC 超过本链上限 ${formatUnits(cap, 6)}`)
  }
  if (feeTokenIsAsset ? feeBalance < amount + prefund : feeBalance < prefund) {
    throw new Error(`${chain.feeToken.symbol} 余额不足以支付实际手续费`)
  }
  if (!feeTokenIsAsset && assetBalance < amount) throw new Error(`${token.symbol} 余额不足`)

  const userOpHash = computeUserOpHash(
    {
      sender,
      nonce: entrypointNonce,
      initCode: '0x',
      callData,
      accountGasLimits: pack128(verificationGas, callGas),
      preVerificationGas,
      gasFees: pack128(fee.maxPriorityFeePerGas, fee.maxFeePerGas),
      paymasterAndData: packPaymasterAndData(
        chain.paymaster,
        paymasterVerificationGas,
        paymasterPostOpGas,
        pmData,
      ),
      delegate: authorization ? chain.implementation : undefined,
      factoryData: '0x',
    },
    chain,
  )
  const signature = await account.sign({ hash: userOpHash })

  const finalOp = buildUserOp(chain, {
    sender,
    nonce: entrypointNonce,
    callData,
    verificationGas,
    callGas,
    preVerificationGas,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    paymasterData: pmData,
    paymasterVerificationGas,
    paymasterPostOpGas,
    signature,
    authorization,
  })
  // 从这里开始结果可能不明：先按 userOpHash 查回执，再决定是否重试。
  broadcastStarted = true
  const delays = [6_000, 15_000, 30_000]
  let returnedHash: Hex | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      returnedHash = await bundlerCall<Hex>(
        chain,
        'eth_sendUserOperation',
        [finalOp, chain.entrypoint],
        45_000,
      )
      break
    } catch (err) {
      lastError = err
      // 响应丢失时 UserOp 可能已经上链；同 nonce 重发前必须先查回执。
      const mined = await waitForUserOpReceipt(chain, userOpHash, 8_000, 2_000).catch(() => null)
      if (mined) return mined
      if (!isTransientNetworkError(err)) {
        throw new PreBroadcastError(
          `${chain.short} 发送被拒绝：${err instanceof Error ? err.message : String(err)}`,
          err,
        )
      }
      if (attempt === delays.length) break
      await sleep(delays[attempt])
    }
  }
  if (!returnedHash) {
    throw new AmbiguousBroadcastError(
      `${chain.short} 发送结果不明：${lastError instanceof Error ? lastError.message : String(lastError)}`,
      userOpHash,
    )
  }
  const receipt = await waitForUserOpReceipt(chain, returnedHash, 180_000)
  return (
    receipt ?? {
      userOpHash: returnedHash,
      status: 'pending',
      explorer: chain.explorerTx,
    }
  )
  } catch (err) {
    if (!broadcastStarted) {
      throw new PreBroadcastError(
        `${chain.short} 发送前失败：${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    throw err
  }
}
