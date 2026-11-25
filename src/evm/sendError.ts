/**
 * 广播失败分类：决定「可以安全重试」还是「结果不明，必须人工核对」。
 *
 * 这是钱包里最危险的判断之一：把已上链的发送误判成可重试，重试会按新 nonce
 * 再发一笔，造成双花。因此这里采取保守策略：
 * - 网络/传输/超时/未知错误 → 结果不明；
 * - AA25 / already known 等可能已被打包的错误 → 结果不明；
 * - 只有明确是验证阶段被拒绝（且调用方已确认 nonce 未变）才允许重试。
 */

import { PreBroadcastError, RpcError } from '../rpc'

export type SendFailureKind = 'retryable' | 'ambiguous'

const AMBIGUOUS_PATTERNS = [
  /AA25/i, // invalid account nonce：可能前一笔已打包，nonce 已被消费
  /AA26/i, // over verification gas limit：可能已在 mempool 重试
  /already known/i,
  /known transaction/i,
  /already been submitted/i,
  /replacement transaction/i,
  /nonce too low/i,
]

const RETRYABLE_PATTERNS = [
  /AA2[1-4]/i, // sender 验证失败：prefund/签名/validUntil/validAfter
  /AA3[1-4]/i, // paymaster / account 验证失败
  /AA4[0-5]/i, // 账户/初始化代码验证失败
  /AA5[0-5]/i, // 执行前/后检查失败
  /paymaster/i,
  /permit/i,
  /prefund/i,
  /invalid signature/i,
  /expired/i,
  /not enough/i,
  /insufficient/i,
  /gas limit/i,
  /simulation/i,
  /validation/i,
]

const AMBIGUOUS_FALLBACK = [/reverted/i, /internal error/i, /unknown error/i]

/** 只根据错误形态分类；调用方还必须用 nonce/回执确认链上状态。 */
export function classifyBundlerSendError(err: unknown): SendFailureKind {
  if (err instanceof PreBroadcastError) return 'retryable'
  const message = err instanceof Error ? err.message : String(err)

  if (err instanceof RpcError && err.kind === 'jsonrpc') {
    if (AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(message))) return 'ambiguous'
    if (RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) return 'retryable'
    if (AMBIGUOUS_FALLBACK.some((pattern) => pattern.test(message))) return 'ambiguous'
    return 'ambiguous'
  }

  // 网络、超时、HTTP 错误、未知异常：请求可能已经到达 bundler。
  return 'ambiguous'
}
