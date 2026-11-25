/**
 * 普通原生币转账（BSC / Ethereum legacy）：本地构造、签名，浏览器直连 RPC 广播。
 * 与 Circle AA 路径完全分离：不使用 7702 / Paymaster / USDC gas。
 */

import { formatEther, isAddress, parseEther, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import type { ChainConfig } from '../chains'
import { BroadcastError, hexToBigInt, rpcCall, rpcRead, sleep, toHex } from '../rpc'

export interface NativeBalance {
  wei: bigint
  amount: string
}

export interface NativeSendInput {
  privateKey: Hex
  to: string
  amount: string
  gasPriceGwei?: string
}

export interface NativeSendResult {
  status: 'success' | 'pending'
  hash: Hex
  from: string
  to: string
  amount: string
  gasUsed: bigint
  effectiveGasPrice: bigint
  fee: string
}

export interface NativeEstimate {
  gasLimit: bigint
  gasPrice: bigint
  fee: string
}

export async function getNativeBalance(chain: ChainConfig, address: string): Promise<NativeBalance> {
  if (!isAddress(address)) throw new Error('地址格式不正确')
  const raw = await rpcRead<string>(chain.rpc, 'eth_getBalance', [address, 'latest'])
  const wei = hexToBigInt(raw)
  return { wei, amount: formatEther(wei) }
}

export async function getNativeGasPrice(chain: ChainConfig): Promise<bigint> {
  return hexToBigInt(await rpcRead<string>(chain.rpc, 'eth_gasPrice', []))
}

function withBuffer(gas: bigint): bigint {
  const buffered = (gas * 120n) / 100n
  return buffered > gas + 1000n ? buffered : gas + 1000n
}

export async function estimateNativeTransfer(
  chain: ChainConfig,
  input: { from: string; to: string; amount: string; gasPriceGwei?: string },
): Promise<NativeEstimate> {
  if (!isAddress(input.from) || !isAddress(input.to)) throw new Error('地址格式不正确')
  const value = parseEther(input.amount || '0')
  if (value <= 0n) throw new Error('金额必须大于 0')
  const estimated = hexToBigInt(
    await rpcRead<string>(chain.rpc, 'eth_estimateGas', [
      { from: input.from, to: input.to, value: toHex(value) },
    ]),
  )
  const gasLimit = withBuffer(estimated)
  const gasPrice = input.gasPriceGwei?.trim()
    ? parseGwei(input.gasPriceGwei.trim())
    : await getNativeGasPrice(chain)
  return { gasLimit, gasPrice, fee: formatEther(gasLimit * gasPrice) }
}

/** 广播后每 3 秒查回执，最多 120 秒；明确区分 pending / success / failed。 */
export async function waitForNativeReceipt(
  chain: ChainConfig,
  hash: Hex,
  timeoutMs = 120_000,
): Promise<{
  status: 'success' | 'failed'
  blockNumber: bigint
  gasUsed: bigint
  effectiveGasPrice: bigint
} | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const receipt = await rpcRead<{
      status: string
      blockNumber: string
      gasUsed: string
      effectiveGasPrice?: string
    } | null>(chain.rpc, 'eth_getTransactionReceipt', [hash])
    if (receipt) {
      return {
        status: receipt.status === '0x1' ? 'success' : 'failed',
        blockNumber: hexToBigInt(receipt.blockNumber),
        gasUsed: hexToBigInt(receipt.gasUsed),
        effectiveGasPrice: hexToBigInt(receipt.effectiveGasPrice || '0x0'),
      }
    }
    await sleep(3000)
  }
  return null
}

export async function sendNative(chain: ChainConfig, input: NativeSendInput): Promise<NativeSendResult> {
  if (!isAddress(input.to)) throw new Error('收款地址格式不正确')
  const value = parseEther(input.amount || '0')
  if (value <= 0n) throw new Error('金额必须大于 0')
  const account = privateKeyToAccount(input.privateKey)
  const from = account.address

  // chainId 防误连：BSC=56、Ethereum=1；RPC 必须与所选链一致。
  const chainId = hexToBigInt(await rpcRead<string>(chain.rpc, 'eth_chainId', []))
  if (chainId !== BigInt(chain.id)) {
    throw new Error(`RPC 返回的 chainId=${chainId}，不是 ${chain.short}(${chain.id})`)
  }

  const [nonceHex, gasPriceHex, estimateHex, balanceHex] = await Promise.all([
    rpcRead<string>(chain.rpc, 'eth_getTransactionCount', [from, 'pending']),
    input.gasPriceGwei?.trim()
      ? Promise.resolve(toHex(parseGwei(input.gasPriceGwei.trim())))
      : rpcRead<string>(chain.rpc, 'eth_gasPrice', []),
    rpcRead<string>(chain.rpc, 'eth_estimateGas', [{ from, to: input.to, value: toHex(value) }]),
    rpcRead<string>(chain.rpc, 'eth_getBalance', [from, 'latest']),
  ])
  const nonce = hexToBigInt(nonceHex)
  const gasPrice = hexToBigInt(gasPriceHex)
  const gas = withBuffer(hexToBigInt(estimateHex))
  const balance = hexToBigInt(balanceHex)
  if (balance < value + gas * gasPrice) {
    throw new Error(`${chain.native.symbol} 余额不足以支付金额和手续费`)
  }

  const signed = await account.signTransaction({
    chainId: chain.id,
    to: input.to as Hex,
    value,
    gas,
    gasPrice,
    nonce: Number(nonce),
  })
  // 广播只打一次；网络错误时结果可能不明，界面提示先查浏览器，不自动重发
  const hash = await rpcCall<Hex>(chain.rpc[0], 'eth_sendRawTransaction', [signed])
  let receipt: Awaited<ReturnType<typeof waitForNativeReceipt>>
  try {
    receipt = await waitForNativeReceipt(chain, hash)
  } catch {
    // 已广播但回执查询失败：结果不明，不能当成失败让调用方重发。
    receipt = null
  }
  if (!receipt) {
    return {
      status: 'pending',
      hash,
      from,
      to: input.to,
      amount: input.amount,
      gasUsed: 0n,
      effectiveGasPrice: gasPrice,
      fee: '待确认',
    }
  }
  if (receipt.status === 'failed') {
    throw new BroadcastError(`交易已上链但执行失败，金额未转出；哈希 ${hash}`, hash)
  }
  return {
    status: 'success',
    hash,
    from,
    to: input.to,
    amount: input.amount,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    fee: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
  }
}
