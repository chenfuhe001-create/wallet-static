/**
 * bundler 请求限速器（滑动窗口 + 全局冷却）。
 *
 * 公共 Pimlico 的 WAF 不是简单的「每秒」限流：短时间打满会触发约 30–60 秒
 * 的连接拒绝（浏览器表现为 `Failed to fetch`），而且冷却期内继续轮询会
 * 让封禁一直续期。这里把「配额」和「冷却」分开：
 * - 滑动窗口限制每分钟请求数；
 * - 触发限流后全局暂停，冷却期内任何请求都排队等待；
 * - 冷却后先降低速率，连续成功再逐步恢复。
 */

export interface BundlerPacerConfig {
  /** 窗口内允许的请求数。 */
  maxPerWindow: number
  /** 窗口长度（毫秒）。 */
  windowMs: number
  /** 两次请求之间的最小间隔（毫秒）。 */
  minIntervalMs: number
  /** 触发限流后的全局冷却（毫秒）。 */
  cooldownMs: number
  /** 冷却后连续成功多少次恢复一档速率。 */
  recoverAfterSuccesses: number
}

export interface PacerClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface BundlerPacerStatus {
  /** 当前生效的每分钟上限（会被限流自适应降低）。 */
  limit: number
  /** 配置的每分钟上限。 */
  maxLimit: number
  /** 最近一个窗口内已经发出的请求数。 */
  usedInWindow: number
  /** 冷却剩余毫秒；0 表示不在冷却。 */
  cooldownRemainingMs: number
  /** 下一个请求还要等多久（含冷却与窗口）。 */
  nextSlotInMs: number
}

const defaultClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** 调用方给不起等待时间时抛出；不消耗配额。 */
export class PacerBusyError extends Error {
  constructor(readonly waitMs: number) {
    super(`bundler 正在冷却/限速，预计还需等待 ${Math.ceil(waitMs / 1000)} 秒`)
    this.name = 'PacerBusyError'
  }
}

export class BundlerPacer {
  private recent: number[] = []
  private lastAt = -Infinity
  private cooldownUntil = 0
  private limit: number
  private successes = 0

  constructor(
    private readonly config: BundlerPacerConfig,
    private readonly clock: PacerClock = defaultClock,
  ) {
    this.limit = config.maxPerWindow
  }

  private prune(now: number): void {
    while (this.recent.length && now - this.recent[0] >= this.config.windowMs) {
      this.recent.shift()
    }
  }

  /** 距离下一个可用槽位还要等多久。 */
  waitMs(now = this.clock.now()): number {
    this.prune(now)
    let wait = Math.max(
      0,
      this.cooldownUntil - now,
      this.lastAt + this.config.minIntervalMs - now,
    )
    if (this.recent.length >= this.limit && this.recent.length > 0) {
      wait = Math.max(wait, this.recent[0] + this.config.windowMs - now)
    }
    return Math.ceil(wait)
  }

  /** 取一个请求配额；等待超过 maxWaitMs 直接报忙。 */
  async acquire(maxWaitMs = Infinity): Promise<void> {
    const wait = this.waitMs()
    if (wait > maxWaitMs) throw new PacerBusyError(wait)
    if (wait > 0) await this.clock.sleep(wait)
    const now = this.clock.now()
    this.prune(now)
    this.recent.push(now)
    this.lastAt = now
  }

  /** 请求成功：冷却后逐步把速率恢复回配置上限。 */
  noteSuccess(): void {
    if (this.limit >= this.config.maxPerWindow) return
    this.successes += 1
    if (this.successes >= this.config.recoverAfterSuccesses) {
      this.limit += 1
      this.successes = 0
    }
  }

  /** 请求失败：网络/限流错误触发全局冷却，并把速率砍半。 */
  noteFailure(rateLimited: boolean): void {
    this.successes = 0
    if (!rateLimited) return
    this.cooldownUntil = this.clock.now() + this.config.cooldownMs
    this.limit = Math.max(1, Math.floor(this.limit / 2))
  }

  status(): BundlerPacerStatus {
    const now = this.clock.now()
    this.prune(now)
    return {
      limit: this.limit,
      maxLimit: this.config.maxPerWindow,
      usedInWindow: this.recent.length,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - now),
      nextSlotInMs: this.waitMs(now),
    }
  }

  reset(): void {
    this.recent = []
    this.lastAt = -Infinity
    this.cooldownUntil = 0
    this.limit = this.config.maxPerWindow
    this.successes = 0
  }
}
