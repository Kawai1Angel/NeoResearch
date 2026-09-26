/** Coalesce event bursts without postponing updates indefinitely during streaming. */
export function createResearchRefresh(
  refresh: () => void,
  intervalMs = 1000,
  clock = {
    now: () => Date.now(),
    schedule: (callback: () => void, ms: number) => setTimeout(callback, ms),
    cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  },
) {
  let last = clock.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  return {
    request() {
      if (disposed || timer !== undefined) return
      timer = clock.schedule(() => {
        timer = undefined
        if (disposed) return
        last = clock.now()
        refresh()
      }, Math.max(0, intervalMs - (clock.now() - last)))
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clock.cancel(timer)
      timer = undefined
    },
  }
}

/** One in-flight read per key. Only explicitly cached reads retain their results. */
export function createResearchReads(now = () => Date.now()) {
  const pending = new Map<string, Promise<unknown>>()
  const cache = new Map<string, { value: unknown; expires: number }>()
  return {
    read<T>(key: string, load: () => Promise<T>, ttlMs = 0): Promise<T> {
      const active = pending.get(key)
      if (active) return active as Promise<T>
      const saved = cache.get(key)
      if (saved && saved.expires > now()) return Promise.resolve(saved.value as T)
      cache.delete(key)
      const request = Promise.resolve().then(load).then((value) => {
        if (ttlMs > 0) cache.set(key, { value, expires: now() + ttlMs })
        return value
      }).finally(() => pending.delete(key))
      pending.set(key, request)
      return request
    },
  }
}
