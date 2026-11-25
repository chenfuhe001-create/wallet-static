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
import { feeCapFor, getAsset, isNativeAssetSymbol } from '../chains'
import type { AaChainConfig, TokenAsset } from '../chains'
import {
  AmbiguousBroadcastError,
  PreBroadcastError,
  isTransientNetworkError,
  rpcRead,
  sleep,
} from '../rpc'
import { PacerBusyError } from './limiter'
import { bundlerCall } from './bundler'
import { classifyBundlerSendError } from './sendError'

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
  /** 资产符号；`native` 或链原生符号表示原生币，其余必须是注册表代币。 */
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

/** 代币：execute(token, 0, transfer(to, amount))；原生币：execute(to, amount, 0x)。 */
export function encodeAaTransferCallData(
  token: TokenAsset | null,
  to: string,
  amount: bigint,
): Hex {
  return token
    ? encodeExecute(token.address, 0n, encodeErc20Transfer(to, amount))
    : encodeExecute(to, amount, '0x')
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

async function readNativeBalance(chain: AaChainConfig, owner: string): Promise<bigint> {
  return hexToBigInt(await rpcRead<Hex>(chain.rpc, 'eth_getBalance', [owner, 'latest']))
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
// 2 分钟：批量里 9 个钱包共用一次 gasPrice，避免每笔都打 bundler；
// 同时用 15% 缓冲覆盖 baseFee 在批量执行期间的小幅上涨。
const GAS_PRICE_TTL_MS = 120_000
const GAS_PRICE_BUFFER_BPS = 1_150n

const gasPriceInFlight = new Map<
  number,
  Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
>()

async function loadGasPrice(
  chain: AaChainConfig,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  try {
    const result = await bundlerCall<{
      standard?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
      fast?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
      slow?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
    }>(chain, 'pimlico_getUserOperationGasPrice', [], 30_000, 20_000)
    const bucket = result.standard || result.fast || result.slow
    if (bucket) {
      const rawMaxFee = hexToBigInt(bucket.maxFeePerGas)
      const maxPriorityFeePerGas = hexToBigInt(bucket.maxPriorityFeePerGas)
      if (rawMaxFee > 0n) {
        return {
          maxFeePerGas: (rawMaxFee * GAS_PRICE_BUFFER_BPS) / 1_000n,
          maxPriorityFeePerGas,
        }
      }
    }
  } catch {
    /* bundler 限流时退回公共 RPC 的 eth_gasPrice */
  }
  const gasPrice = hexToBigInt(await rpcRead<Hex>(chain.rpc, 'eth_gasPrice', []))
  if (gasPrice <= 0n) throw new Error(`无法获取 ${chain.short} gasPrice`)
  return {
    maxFeePerGas: (gasPrice * 12n) / 10n,
    maxPriorityFeePerGas: gasPrice < 1_000_000_000n ? gasPrice : 1_000_000_000n,
  }
}

export async function getBundlerGasPrice(
  chain: AaChainConfig,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const cached = gasPriceCache.get(chain.id)
  if (cached && Date.now() - cached.at < GAS_PRICE_TTL_MS) return cached.value
  // 批量里 3 个并发 worker 会同时要 gasPrice；共用同一个 in-flight 请求，
  // 避免缓存未命中时一次打 3 个 bundler 请求。
  const existing = gasPriceInFlight.get(chain.id)
  if (existing) return existing

  const pending = loadGasPrice(chain)
    .then((value) => {
      gasPriceCache.set(chain.id, { at: Date.now(), value })
      return value
    })
    .finally(() => gasPriceInFlight.delete(chain.id))
  gasPriceInFlight.set(chain.id, pending)
  return pending
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

interface GasEstimate {
  at: number
  value: Record<string, bigint>
}

const gasEstimateCache = new Map<string, GasEstimate>()
const gasEstimateInFlight = new Map<string, Promise<Record<string, bigint>>>()
// 同一链、同一激活状态、同一资产、同一调用笔数的 UserOp，gas 上限基本一致。
// 批量里只估算第一笔，其余复用并加安全缓冲，避免每个钱包都打一次 bundler。
const GAS_ESTIMATE_TTL_MS = 10 * 60_000

export function gasEstimateKey(
  chain: AaChainConfig,
  firstActivation: boolean,
  assetKey: string,
  calls = 1,
): string {
  return `${chain.id}:${firstActivation ? 'first' : 'delegated'}:${assetKey}:${calls}`
}

/** 复用估算结果时加缓冲：冷收款地址、不同钱包的签名/授权差异都可能多耗 gas。 */
export function bufferGasLimit(field: string, value: bigint, reused: boolean): bigint {
  if (!reused) return value
  const buffers: Record<string, [bigint, bigint]> = {
    verificationGasLimit: [125n, 10_000n],
    callGasLimit: [150n, 20_000n],
    preVerificationGas: [120n, 5_000n],
    paymasterVerificationGasLimit: [150n, 20_000n],
    paymasterPostOpGasLimit: [150n, 10_000n],
  }
  const [percent, extra] = buffers[field] ?? [120n, 5_000n]
  return (value * percent) / 100n + extra
}

async function estimateUserOpGas(chain: AaChainConfig, op: UserOpJson): Promise<Record<string, bigint>> {
  const result = await bundlerCall<Record<string, string>>(
    chain,
    'eth_estimateUserOperationGas',
    [op, chain.entrypoint],
    45_000,
    120_000,
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

interface ReceiptLog {
  address?: string
  topics?: string[]
  data?: Hex
}

export interface UserOpReceiptRaw {
  success?: boolean
  actualGasCost?: Hex
  logs?: ReceiptLog[]
  receipt?: {
    transactionHash?: Hex
    status?: Hex
    logs?: ReceiptLog[]
  }
}

/** 把 bundler 回执转成钱包结果；费用只认 Circle 的 UserOperationSponsored 事件。 */
export function parseUserOpReceipt(
  chain: AaChainConfig,
  hash: Hex,
  receipt: UserOpReceiptRaw,
): AaTransferResult {
  const txHash = receipt.receipt?.transactionHash
  let feeUsdc: string | undefined
  // Circle 的 UserOperationSponsored 里 actualTokenNeeded 才是用户实际支付的 USDC
  // （base + spread；当前 OP 上 feeTokenAmount 为 0）。actualGasCost 是 native wei，不能当 USDC。
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

/** 单次回执查询；排队时间超过 maxWaitMs 会抛 PacerBusyError，不消耗配额。 */
export async function fetchUserOpReceipt(
  chain: AaChainConfig,
  hash: Hex,
  maxWaitMs = 30_000,
): Promise<AaTransferResult | null> {
  const raw = await bundlerCall<UserOpReceiptRaw | null>(
    chain,
    'eth_getUserOperationReceipt',
    [hash],
    30_000,
    maxWaitMs,
  )
  return raw ? parseUserOpReceipt(chain, hash, raw) : null
}

/**
 * 兼容旧调用：按退避轮询回执。
 * 批量核对已改用 `bundlerBatch`，这里只给单笔场景使用。
 */
export async function waitForUserOpReceipt(
  chain: AaChainConfig,
  hash: Hex,
  timeoutMs = 120_000,
  pollMs = 5_000,
): Promise<AaTransferResult | null> {
  const start = Date.now()
  let delay = pollMs
  while (Date.now() - start < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - start)
    try {
      const receipt = await fetchUserOpReceipt(chain, hash, Math.min(remaining, 20_000))
      if (receipt) return receipt
    } catch (err) {
      if (err instanceof PacerBusyError) {
        await sleep(Math.min(err.waitMs, Math.max(0, remaining)))
        continue
      }
      /* 网络抖动时继续退避，不在冷却期里打点 */
    }
    await sleep(Math.min(delay, Math.max(0, timeoutMs - (Date.now() - start))))
    delay = Math.min(delay * 2, 30_000)
  }
  return null
}

/**
 * 用 EntryPoint nonce（普通 RPC，不占 bundler 配额）等待 UserOp 被打包。
 * nonce 推进后再查一次 bundler 回执拿交易哈希/手续费。
 */
export async function waitForUserOpInclusion(
  chain: AaChainConfig,
  sender: string,
  nonce: bigint,
  hash: Hex,
  timeoutMs = 120_000,
): Promise<AaTransferResult | null> {
  const start = Date.now()
  let receiptTries = 0
  while (Date.now() - start < timeoutMs) {
    let current: bigint | null = null
    try {
      current = await getEntryPointNonce(chain, sender)
    } catch {
      /* RPC 抖动：继续等，nonce 查询不占 bundler 配额 */
    }
    if (current !== null && current > nonce) {
      const remaining = Math.max(5_000, timeoutMs - (Date.now() - start))
      // 批量里回执请求可能排在多个发送后面；给足排队预算，避免把已成功的笔误判为 pending。
      const receipt = await fetchUserOpReceipt(chain, hash, Math.min(120_000, remaining)).catch(
        () => null,
      )
      if (receipt) return receipt
      receiptTries += 1
      if (receiptTries >= 3) {
        return { userOpHash: hash, status: 'pending', explorer: chain.explorerTx }
      }
      await sleep(3_000)
      continue
    }
    await sleep(3_000)
  }
  // 执行失败的 UserOp 可能不会推进 nonce，最后再按哈希查一次。
  return fetchUserOpReceipt(chain, hash, 15_000).catch(() => null)
}

interface InclusionCheck {
  receipt: AaTransferResult | null
  nonceKnown: boolean
  advanced: boolean
}

/** 广播报错后，先用免费 RPC 判断 nonce 是否已推进，再决定能否安全重试。 */
async function inspectInclusion(
  chain: AaChainConfig,
  sender: string,
  nonce: bigint,
  hash: Hex,
): Promise<InclusionCheck> {
  let nonceKnown = false
  let advanced = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await getEntryPointNonce(chain, sender)
      nonceKnown = true
      if (current > nonce) {
        advanced = true
        break
      }
    } catch {
      /* RPC 抖动：再试一次 */
    }
    if (attempt < 2) await sleep(3_000)
  }
  const receipt = advanced
    ? await fetchUserOpReceipt(chain, hash, 120_000).catch(() => null)
    : null
  return { receipt, nonceKnown, advanced }
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
  const nativeTransfer = isNativeAssetSymbol(chain, input.asset)
  const token = nativeTransfer ? null : getAsset(chain, input.asset)
  const amount = parseUnits(input.amount || '0', token ? token.decimals : chain.native.decimals)
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
  const feeTokenIsAsset = Boolean(
    token && token.address.toLowerCase() === chain.feeToken.address.toLowerCase(),
  )
  const [feeBalance, assetBalance, nativeBalance] = await Promise.all([
    readTokenBalance(chain, chain.feeToken, sender),
    token && !feeTokenIsAsset ? readTokenBalance(chain, token, sender) : Promise.resolve(0n),
    token ? Promise.resolve(0n) : readNativeBalance(chain, sender),
  ])
  if (feeTokenIsAsset ? feeBalance < amount + cap : feeBalance < cap) {
    throw new Error(`${chain.feeToken.symbol} 余额不足以支付手续费上限`)
  }
  if (token && !feeTokenIsAsset && assetBalance < amount) {
    throw new Error(`${token.symbol} 余额不足`)
  }
  if (!token && nativeBalance < amount) throw new Error(`${chain.native.symbol} 余额不足`)

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
  const callData = encodeAaTransferCallData(token, input.to, amount)

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
  const cacheKey = gasEstimateKey(chain, firstActivation, token ? token.address.toLowerCase() : 'native')
  const cachedEstimate = gasEstimateCache.get(cacheKey)
  let est: Record<string, bigint>
  let reusedEstimate = false
  if (cachedEstimate && Date.now() - cachedEstimate.at < GAS_ESTIMATE_TTL_MS) {
    est = cachedEstimate.value
    reusedEstimate = true
  } else {
    // 3 个并发 worker 可能同时命中同一个 key；只让第一个真正估算，其余复用。
    const existing = gasEstimateInFlight.get(cacheKey)
    if (existing) {
      est = await existing
      reusedEstimate = true
    } else {
      const pending = estimateUserOpGas(chain, estimateOp)
        .then((value) => {
          gasEstimateCache.set(cacheKey, { at: Date.now(), value })
          return value
        })
        .finally(() => gasEstimateInFlight.delete(cacheKey))
      gasEstimateInFlight.set(cacheKey, pending)
      est = await pending
    }
  }

  const verificationGas = bufferGasLimit(
    'verificationGasLimit',
    est.verificationGasLimit,
    reusedEstimate,
  )
  const callGas = bufferGasLimit('callGasLimit', est.callGasLimit, reusedEstimate)
  const preVerificationGas = bufferGasLimit(
    'preVerificationGas',
    est.preVerificationGas,
    reusedEstimate,
  )
  const paymasterVerificationGas = bufferGasLimit(
    'paymasterVerificationGasLimit',
    est.paymasterVerificationGasLimit && est.paymasterVerificationGasLimit > 200_000n
      ? est.paymasterVerificationGasLimit
      : 200_000n,
    reusedEstimate,
  )
  const paymasterPostOpGas = bufferGasLimit(
    'paymasterPostOpGasLimit',
    est.paymasterPostOpGasLimit && est.paymasterPostOpGasLimit > 50_000n
      ? est.paymasterPostOpGasLimit
      : 50_000n,
    reusedEstimate,
  )
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
  if (token && !feeTokenIsAsset && assetBalance < amount) {
    throw new Error(`${token.symbol} 余额不足`)
  }
  if (!token && nativeBalance < amount) throw new Error(`${chain.native.symbol} 余额不足`)

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
  // 从这里开始结果可能不明：任何广播错误都先看 nonce/回执，再决定是否重试。
  broadcastStarted = true
  let returnedHash: Hex | null = null
  try {
    returnedHash = await bundlerCall<Hex>(
      chain,
      'eth_sendUserOperation',
      [finalOp, chain.entrypoint],
      60_000,
      120_000,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const firstCheck = await inspectInclusion(chain, sender, entrypointNonce, userOpHash)
    if (firstCheck.receipt) return firstCheck.receipt

    const kind = classifyBundlerSendError(err)
    if (kind === 'retryable' && firstCheck.nonceKnown && !firstCheck.advanced) {
      // 明确是验证阶段被拒，且 nonce 没动：交易肯定没发出，可安全重试。
      throw new PreBroadcastError(`${chain.short} 发送被拒绝：${message}`, err)
    }

    // 网络错误且 nonce 未变：同签名、同 nonce 重试一次是幂等的；
    // 若已进 mempool，重试会被拒绝，不会产生第二笔。
    if (isTransientNetworkError(err) && firstCheck.nonceKnown && !firstCheck.advanced) {
      try {
        returnedHash = await bundlerCall<Hex>(
          chain,
          'eth_sendUserOperation',
          [finalOp, chain.entrypoint],
          60_000,
          120_000,
        )
      } catch (retryErr) {
        const secondCheck = await inspectInclusion(chain, sender, entrypointNonce, userOpHash)
        if (secondCheck.receipt) return secondCheck.receipt
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr)
        throw new AmbiguousBroadcastError(
          `${chain.short} 发送结果不明：${retryMessage}`,
          userOpHash,
        )
      }
    } else {
      throw new AmbiguousBroadcastError(
        `${chain.short} 发送结果不明：${message}`,
        userOpHash,
      )
    }
  }
  if (!returnedHash) {
    throw new AmbiguousBroadcastError(`${chain.short} 发送结果不明：未拿到 UserOp 哈希`, userOpHash)
  }
  // 回执等待走普通 RPC 的 EntryPoint nonce，只有 nonce 推进后才查一次 bundler。
  const receipt = await waitForUserOpInclusion(
    chain,
    sender,
    entrypointNonce,
    returnedHash,
    120_000,
  )
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
