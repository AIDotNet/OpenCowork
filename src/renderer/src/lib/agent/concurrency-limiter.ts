/**
 * A simple semaphore-based concurrency limiter.
 * Allows at most `maxConcurrent` tasks to run simultaneously;
 * additional tasks are queued and started as earlier ones finish.
 */
export class ConcurrencyLimiter {
  private running = 0
  private queue: Array<() => void> = []
  private _maxConcurrent: number

  constructor(maxConcurrent: number) {
    this._maxConcurrent = maxConcurrent
  }

  /** Current number of running tasks. */
  get activeCount(): number {
    return this.running
  }

  /** Configured maximum number of concurrent tasks. */
  get maxConcurrent(): number {
    return this._maxConcurrent
  }

  /**
   * Update the concurrency cap at runtime. Raising it drains any queued tasks
   * that now fit under the new cap. Each dequeued task's `enqueue` closure
   * increments `running` itself (see {@link acquire}), so we must NOT
   * pre-increment here — just invoke under the recomputed guard.
   */
  setMax(n: number): void {
    this._maxConcurrent = Math.max(1, Math.floor(n))
    while (this.running < this._maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    }
  }

  /** Current number of queued (waiting) tasks. */
  get waitingCount(): number {
    return this.queue.length
  }

  /**
   * Acquire a slot. Resolves immediately if a slot is available,
   * otherwise blocks until one opens up.
   * Supports AbortSignal — rejects with AbortError if aborted while waiting.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    }

    if (this.running < this._maxConcurrent) {
      this.running++
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = this.queue.indexOf(enqueue)
        if (idx !== -1) this.queue.splice(idx, 1)
        reject(new DOMException('Aborted', 'AbortError'))
      }

      const enqueue = (): void => {
        signal?.removeEventListener('abort', onAbort)
        this.running++
        resolve()
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(enqueue)
    })
  }

  /** Release a slot, allowing the next queued task to proceed. */
  release(): void {
    this.running = Math.max(0, this.running - 1)
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    }
  }

  /**
   * Convenience wrapper: acquire → run fn → release.
   * Automatically releases even if fn throws.
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
