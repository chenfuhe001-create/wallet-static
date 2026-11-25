/** BSC 原生 BNB：本地构造/签名，浏览器直连 RPC 广播；服务器不参与。 */

import { formatEther, isAddress, parseEther, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { BSC } from '../chains'
import { BroadcastError, hexToBigInt, rpcCall, rpcRead, sleep, toHex, RpcError } from '../rpc'

export interface BscBalance {
  wei: bigint
  bnb: string
}

export interface BscSendInput {
  privateKey: Hex
  to: string
  amountBnb: string
  gasPriceGwei?: string
}

export interface BscSendResult {
  status: 'success' | 'pending'
  hash: Hex
  from: string
  to: string
  amountBnb: string
  gasUsed: bigint
  effectiveGasPrice: bigint
  feeBnb: string
}

export interface BscEstimate {
  gasLimit: bigint
  gasPrice: bigint
  feeBnb: string
}

export async function getBscBalance(address: string): Promise<BscBalance> {
  if (!isAddress(address)) throw new Error('地址格式不正确')
  const raw = await rpcRead<string>(BSC.rpc, 'eth_getBalance', [address, 'latest'])
  const wei = hexToBigInt(raw)
  return { wei, bnb: formatEther(wei) }
}

export async function getBscGasPrice(): Promise<bigint> {
  return hexToBigInt(await rpcRead<string>(BSC.rpc, 'eth_gasPrice', []))
}

function withBuffer(gas: bigint): bigint {
  const buffered = (gas * 120n) / 100n
  return buffered > gas + 1000n ? buffered : gas + 1000n
}

export async function estimateBnbTransfer(input: {
  from: string
  to: string
  amountBnb: string
  gasPriceGwei?: string
}): Promise<BscEstimate> {
  if (!isAddress(input.from) || !isAddress(input.to)) throw new Error('地址格式不正确')
  const value = parseEther(input.amountBnb || '0')
  if (value <= 0n) throw new Error('金额必须大于 0')
  const estimated = hexToBigInt(
    await rpcRead<string>(BSC.rpc, 'eth_estimateGas', [
      { from: input.from, to: input.to, value: toHex(value) },
    ]),
  )
  const gasLimit = withBuffer(estimated)
  const gasPrice = input.gasPriceGwei?.trim()
    ? parseGwei(input.gasPriceGwei.trim())
    : await getBscGasPrice()
  return {
    gasLimit,
    gasPrice,
    feeBnb: formatEther(gasLimit * gasPrice),
  }
}

/** 广播后每 3 秒查回执，最多 120 秒；明确区分 pending / success / failed。 */
export async function waitForBscReceipt(
  hash: Hex,
  timeoutMs = 120_000,
): Promise<{ status: 'success' | 'failed'; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const receipt = await rpcRead<{
      status: string
      blockNumber: string
      gasUsed: string
      effectiveGasPrice?: string
    } | null>(BSC.rpc, 'eth_getTransactionReceipt', [hash])
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

export async function sendBnb(input: BscSendInput): Promise<BscSendResult> {
  if (!isAddress(input.to)) throw new Error('收款地址格式不正确')
  const value = parseEther(input.amountBnb || '0')
  if (value <= 0n) throw new Error('金额必须大于 0')
  const account = privateKeyToAccount(input.privateKey)
  const from = account.address

  // chainId 防误连：BSC 必须是 56
  const chainId = hexToBigInt(await rpcRead<string>(BSC.rpc, 'eth_chainId', []))
  if (chainId !== 56n) throw new Error(`RPC 返回的 chainId=${chainId}，不是 BSC(56)`)

  const [nonceHex, gasPriceHex, estimateHex, balanceHex] = await Promise.all([
    rpcRead<string>(BSC.rpc, 'eth_getTransactionCount', [from, 'pending']),
    input.gasPriceGwei?.trim()
      ? Promise.resolve(toHex(parseGwei(input.gasPriceGwei.trim())))
      : rpcRead<string>(BSC.rpc, 'eth_gasPrice', []),
    rpcRead<string>(BSC.rpc, 'eth_estimateGas', [{ from, to: input.to, value: toHex(value) }]),
    rpcRead<string>(BSC.rpc, 'eth_getBalance', [from, 'latest']),
  ])
  const nonce = hexToBigInt(nonceHex)
  const gasPrice = hexToBigInt(gasPriceHex)
  const gas = withBuffer(hexToBigInt(estimateHex))
  const balance = hexToBigInt(balanceHex)
  if (balance < value + gas * gasPrice) {
    throw new Error('BNB 余额不足以支付金额和手续费')
  }

  const signed = await account.signTransaction({
    chainId: 56,
    to: input.to as Hex,
    value,
    gas,
    gasPrice,
    nonce: Number(nonce),
  })
  // 广播只打一次；网络错误时结果可能不明，界面提示先查浏览器，不自动重发
  const hash = await rpcCall<Hex>(BSC.rpc[0], 'eth_sendRawTransaction', [signed])
  let receipt: Awaited<ReturnType<typeof waitForBscReceipt>>
  try {
    receipt = await waitForBscReceipt(hash)
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
      amountBnb: input.amountBnb,
      gasUsed: 0n,
      effectiveGasPrice: gasPrice,
      feeBnb: '待确认',
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
    amountBnb: input.amountBnb,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    feeBnb: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
  }
}

export { RpcError }
