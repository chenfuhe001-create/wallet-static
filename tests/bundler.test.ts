import { describe, expect, it } from 'vitest'
import { BundlerPacer, PacerBusyError } from '../src/evm/limiter'
import type { PacerClock } from '../src/evm/limiter'

class FakeClock implements PacerClock {
  t = 0
  now(): number {
    return this.t
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms
  }
}

const CONFIG = {
  maxPerWindow: 3,
  windowMs: 60_000,
  minIntervalMs: 10_000,
  cooldownMs: 60_000,
  recoverAfterSuccesses: 4,
}

describe('bundler 限速器', () => {
  it('强制最小间隔', async () => {
    const clock = new FakeClock()
    const pacer = new BundlerPacer(CONFIG, clock)
    await pacer.acquire()
    await pacer.acquire()
    expect(clock.t).toBe(10_000)
    await pacer.acquire()
    expect(clock.t).toBe(20_000)
  })

  it('滑动窗口内不超过上限', async () => {
    const clock = new FakeClock()
    const pacer = new BundlerPacer(CONFIG, clock)
    await pacer.acquire()
    await pacer.acquire()
    await pacer.acquire()
    expect(pacer.status().usedInWindow).toBe(3)
    // 第三笔在 20s，窗口要等到第一笔离开 60s 窗口（t=60s）才能再发。
    await pacer.acquire()
    expect(clock.t).toBe(60_000)
    expect(pacer.status().usedInWindow).toBe(3)
  })

  it('等待时间超过调用方预算时立即报忙，不消耗配额', async () => {
    const clock = new FakeClock()
    const pacer = new BundlerPacer(CONFIG, clock)
    await pacer.acquire()
    await pacer.acquire()
    await pacer.acquire()
    await expect(pacer.acquire(5_000)).rejects.toBeInstanceOf(PacerBusyError)
    expect(clock.t).toBe(20_000)
    expect(pacer.status().usedInWindow).toBe(3)
  })

  it('限流错误触发全局冷却，并降低后续速率', async () => {
    const clock = new FakeClock()
    const pacer = new BundlerPacer(CONFIG, clock)
    await pacer.acquire()
    pacer.noteFailure(true)
    expect(pacer.status().cooldownRemainingMs).toBe(60_000)
    expect(pacer.status().limit).toBeLessThan(CONFIG.maxPerWindow)
    await pacer.acquire()
    expect(clock.t).toBe(60_000)
  })

  it('冷却后连续成功会逐步恢复速率', async () => {
    const clock = new FakeClock()
    const pacer = new BundlerPacer(CONFIG, clock)
    await pacer.acquire()
    pacer.noteFailure(true)
    const reduced = pacer.status().limit
    for (let i = 0; i < CONFIG.recoverAfterSuccesses; i += 1) pacer.noteSuccess()
    expect(pacer.status().limit).toBe(reduced + 1)
  })
})
