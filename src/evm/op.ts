/**
 * Optimism + Circle Paymaster v0.8 + EIP-7702 的本地 AA 实现。
 *
 * 所有签名（permit / UserOp / 7702 授权）都在浏览器完成；bundler 只接收
 * 已签名的 UserOp，无法改收款地址/金额。服务器完全不参与。
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
import { OP } from '../chains'
import { rpcCall, rpcRead, sleep, type RpcEndpoint } from '../rpc'

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

const STUB_SIGNATURE: Hex =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c'
const MAX_UINT256 = (1n << 256n) - 1n
const BUNDLER_ENDPOINT: RpcEndpoint = { url: OP.bundler, label: 'Pimlico' }

export interface OpDelegation {
  status: 'none' | 'delegated' | 'contract' | 'unknown'
  implementation?: string
  codeLength: number
}

export interface OpOverview {
  address: string
  usdc: string
  eth: string
  delegation: OpDelegation
}

export interface OpTransferInput {
  privateKey: Hex
  to: string
  amountUsdc: string
}

export interface OpTransferResult {
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

async function readUint(to: string, data: Hex): Promise<bigint> {
  const raw = await rpcRead<Hex>(OP.rpc, 'eth_call', [{ to, data }, 'latest'])
  return hexToBigInt(raw)
}

async function readTokenString(token: string, selector: Hex): Promise<string> {
  const raw = await rpcRead<Hex>(OP.rpc, 'eth_call', [{ to: token, data: selector }, 'latest'])
  return readStringResult(raw)
}

export async function getDelegation(address: string): Promise<OpDelegation> {
  const code = await rpcRead<Hex>(OP.rpc, 'eth_getCode', [address, 'latest'])
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

export async function getOpOverview(address: string): Promise<OpOverview> {
  if (!isAddress(address)) throw new Error('地址格式不正确')
  const [usdcRaw, ethRaw, delegation] = await Promise.all([
    readUint(OP.usdc, concat([BALANCE_OF_SELECTOR, encodeAbiParameters([{ type: 'address' }], [address])])),
    rpcRead<Hex>(OP.rpc, 'eth_getBalance', [address, 'latest']),
    getDelegation(address),
  ])
  return {
    address,
    usdc: formatUnits(usdcRaw, 6),
    eth: formatUnits(hexToBigInt(ethRaw), 18),
    delegation,
  }
}

async function getBundlerGasPrice(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  try {
    const result = await rpcCall<{
      standard?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
      fast?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
      slow?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
    }>(BUNDLER_ENDPOINT, 'pimlico_getUserOperationGasPrice', [], 30_000)
    const bucket = result.standard || result.fast || result.slow
    if (bucket) {
      const maxFeePerGas = hexToBigInt(bucket.maxFeePerGas)
      const maxPriorityFeePerGas = hexToBigInt(bucket.maxPriorityFeePerGas)
      if (maxFeePerGas > 0n) return { maxFeePerGas, maxPriorityFeePerGas }
    }
  } catch {
    /* fallback */
  }
  const gasPrice = hexToBigInt(await rpcRead<Hex>(OP.rpc, 'eth_gasPrice', []))
  if (gasPrice <= 0n) throw new Error('无法获取 OP gasPrice')
  return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice < 1_000_000_000n ? gasPrice : 1_000_000_000n }
}

interface PaymasterState {
  nativeTokenPrice: bigint
  feeSpreadBips: bigint
  additionalGasCharge: bigint
}

async function getPaymasterState(): Promise<PaymasterState> {
  const [price, spread, additional] = await Promise.all([
    readUint(OP.paymaster, FETCH_PRICE_SELECTOR),
    readUint(OP.paymaster, FEE_SPREAD_SELECTOR),
    readUint(OP.paymaster, ADDITIONAL_GAS_SELECTOR),
  ])
  if (price <= 0n) throw new Error('Circle Paymaster 价格预言机不可读')
  return {
    nativeTokenPrice: price,
    feeSpreadBips: spread > 1000n ? spread : 1000n,
    additionalGasCharge: additional > 0n ? additional : 35_000n,
  }
}

function estimatePrefund(input: {
  nativeTokenPrice: bigint
  additionalGasCharge: bigint
  maxFeePerGas: bigint
  totalGas: bigint
  feeSpreadBips: bigint
}): bigint {
  const gasCost = (input.totalGas + input.additionalGasCharge) * input.maxFeePerGas
  const base = (gasCost * input.nativeTokenPrice) / 10n ** 18n + 1n
  const spread = (base * input.feeSpreadBips) / 10_000n
  return base + spread
}

async function getEntryPointNonce(sender: string): Promise<bigint> {
  const data = concat([
    GET_NONCE_SELECTOR,
    encodeAbiParameters([{ type: 'address' }, { type: 'uint192' }], [sender as Hex, 0n]),
  ])
  return readUint(OP.entrypoint, data)
}

async function getPermitNonce(owner: string): Promise<bigint> {
  return readUint(OP.usdc, concat([NONCES_SELECTOR, encodeAbiParameters([{ type: 'address' }], [owner as Hex])]))
}

async function getUsdcBalance(owner: string): Promise<bigint> {
  return readUint(OP.usdc, concat([BALANCE_OF_SELECTOR, encodeAbiParameters([{ type: 'address' }], [owner as Hex])]))
}

export function computeUserOpHash(input: {
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
}): Hex {
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
      [DOMAIN_TYPEHASH, ERC4337_NAME_HASH, ERC4337_VERSION_HASH, BigInt(OP.id), OP.entrypoint as Hex],
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

function buildUserOp(input: {
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
}): UserOpJson {
  const op: UserOpJson = {
    sender: input.sender,
    nonce: hx(input.nonce),
    callData: input.callData,
    callGasLimit: hx(input.callGas),
    verificationGasLimit: hx(input.verificationGas),
    preVerificationGas: hx(input.preVerificationGas),
    maxFeePerGas: hx(input.maxFeePerGas),
    maxPriorityFeePerGas: hx(input.maxPriorityFeePerGas),
    paymaster: OP.paymaster,
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

async function signAuthorization(account: ReturnType<typeof privateKeyToAccount>, nonce: bigint) {
  const signed = await account.signAuthorization({
    chainId: OP.id,
    address: OP.implementation,
    nonce: Number(nonce),
  })
  return {
    address: OP.implementation,
    chainId: `0x${OP.id.toString(16)}`,
    nonce: `0x${nonce.toString(16)}`,
    yParity: `0x${Number(signed.yParity).toString(16)}`,
    r: signed.r,
    s: signed.s,
  }
}

async function estimateUserOpGas(op: UserOpJson): Promise<Record<string, bigint>> {
  const result = await rpcCall<Record<string, string>>(
    BUNDLER_ENDPOINT,
    'eth_estimateUserOperationGas',
    [op, OP.entrypoint],
    45_000,
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

async function waitForUserOpReceipt(hash: Hex, timeoutMs = 120_000): Promise<OpTransferResult | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await rpcCall<{
        success?: boolean
        actualGasCost?: Hex
        receipt?: { transactionHash?: Hex; status?: Hex }
      } | null>(BUNDLER_ENDPOINT, 'eth_getUserOperationReceipt', [hash], 30_000)
      if (receipt) {
        const txHash = receipt.receipt?.transactionHash
        return {
          userOpHash: hash,
          txHash,
          status: receipt.success === false ? 'failed' : 'success',
          feeUsdc: receipt.actualGasCost ? formatUnits(hexToBigInt(receipt.actualGasCost), 6) : undefined,
          explorer: txHash ? `${OP.explorerTx}${txHash}` : OP.explorerTx,
        }
      }
    } catch {
      /* bundler 只读 429 时继续等 */
    }
    await sleep(3000)
  }
  return null
}

/**
 * 用本地私钥发一笔 OP USDC（Circle Paymaster 付 gas）。
 * 流程与服务器 wallet_aa 完全同口径，但私钥/签名不离开浏览器。
 */
export async function sendOpUsdc(input: OpTransferInput): Promise<OpTransferResult> {
  if (!isAddress(input.to)) throw new Error('收款地址格式不正确')
  const amount = parseUnits(input.amountUsdc || '0', 6)
  if (amount <= 0n) throw new Error('金额必须大于 0')

  const account = privateKeyToAccount(input.privateKey)
  const sender = account.address
  const chainId = hexToBigInt(await rpcRead<Hex>(OP.rpc, 'eth_chainId', []))
  if (chainId !== BigInt(OP.id)) throw new Error(`RPC chainId=${chainId}，不是 OP(${OP.id})`)

  const delegation = await getDelegation(sender)
  if (delegation.status === 'contract') throw new Error('发送地址是合约，无法用 7702 钱包')
  if (
    delegation.status === 'delegated' &&
    delegation.implementation?.toLowerCase() !== OP.implementation.toLowerCase()
  ) {
    throw new Error(`该地址已委托到其他 7702 实现：${delegation.implementation}`)
  }
  const firstActivation = delegation.status === 'none'

  const cap = parseUnits(firstActivation ? OP.firstFeeCapUsdc : OP.feeCapUsdc, 6)
  const balance = await getUsdcBalance(sender)
  if (balance < amount + cap) throw new Error('USDC 余额不足以支付金额和手续费上限')

  const [entrypointNonce, fee, tokenName, tokenVersion, permitNonce] = await Promise.all([
    getEntryPointNonce(sender),
    getBundlerGasPrice(),
    readTokenString(OP.usdc, NAME_SELECTOR),
    readTokenString(OP.usdc, VERSION_SELECTOR),
    getPermitNonce(sender),
  ])

  let authorization: Record<string, string> | undefined
  if (firstActivation) {
    const txCount = hexToBigInt(
      await rpcRead<Hex>(OP.rpc, 'eth_getTransactionCount', [sender, 'pending']),
    )
    authorization = await signAuthorization(account, txCount)
  }

  // EIP-2612 permit：spender = Circle Paymaster，额度 = 本链手续费上限
  const permitSignature = await account.signTypedData({
    domain: {
      name: tokenName,
      version: tokenVersion,
      chainId: OP.id,
      verifyingContract: OP.usdc,
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
      spender: OP.paymaster,
      value: cap,
      nonce: permitNonce,
      deadline: MAX_UINT256,
    },
  })

  const pmData = packPaymasterData(OP.usdc, cap, permitSignature)
  const callData = encodeExecute(OP.usdc, 0n, encodeErc20Transfer(input.to, amount))

  const estimateOp = buildUserOp({
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
  const est = await estimateUserOpGas(estimateOp)
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

  const pm = await getPaymasterState()
  const prefund = estimatePrefund({
    nativeTokenPrice: pm.nativeTokenPrice,
    additionalGasCharge: pm.additionalGasCharge,
    maxFeePerGas: fee.maxFeePerGas,
    totalGas,
    feeSpreadBips: pm.feeSpreadBips,
  })
  if (prefund > cap) {
    throw new Error(`预计手续费 ${formatUnits(prefund, 6)} USDC 超过本链上限 ${formatUnits(cap, 6)}`)
  }
  if (balance < amount + prefund) throw new Error('USDC 余额不足以支付金额和实际手续费')

  const userOpHash = computeUserOpHash({
    sender,
    nonce: entrypointNonce,
    initCode: '0x',
    callData,
    accountGasLimits: pack128(verificationGas, callGas),
    preVerificationGas,
    gasFees: pack128(fee.maxPriorityFeePerGas, fee.maxFeePerGas),
    paymasterAndData: packPaymasterAndData(
      OP.paymaster,
      paymasterVerificationGas,
      paymasterPostOpGas,
      pmData,
    ),
    delegate: authorization ? OP.implementation : undefined,
    factoryData: '0x',
  })
  const signature = await account.sign({ hash: userOpHash })

  const finalOp = buildUserOp({
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
  const returnedHash = await rpcCall<Hex>(
    BUNDLER_ENDPOINT,
    'eth_sendUserOperation',
    [finalOp, OP.entrypoint],
    45_000,
  )
  const receipt = await waitForUserOpReceipt(returnedHash)
  return (
    receipt ?? {
      userOpHash: returnedHash,
      status: 'pending',
      explorer: OP.explorerTx,
    }
  )
}
