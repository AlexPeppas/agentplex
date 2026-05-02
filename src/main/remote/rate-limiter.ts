interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {
    // Periodically clean up expired windows to prevent memory leaks
    this.cleanupInterval = setInterval(() => this.cleanup(), windowMs * 2);
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  check(key: string): boolean {
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window || now >= window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (window.count < this.maxRequests) {
      window.count++;
      return true;
    }

    return false;
  }

  /** Seconds until the current window resets for a given key. */
  retryAfter(key: string): number {
    const window = this.windows.get(key);
    if (!window) return 0;
    return Math.max(0, Math.ceil((window.resetAt - Date.now()) / 1000));
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) {
        this.windows.delete(key);
      }
    }
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.windows.clear();
  }
}
