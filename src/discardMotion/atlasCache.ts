// Only exact, decorated transient motion atlases. Ordinary tiles remain native
// SVG. Keys include all frozen CSS/artwork/pixel phase, not record or flight IDs.
export function createMotionAtlasCache(budget = 8 * 1024 * 1024) {
  const entries = new Map<string, Uint8ClampedArray>()
  let bytes = 0, generation = 0
  const size = (key: string, pixels: Uint8ClampedArray) => key.length * 2 + pixels.byteLength
  return {
    get bytes() { return bytes },
    get generation() { return generation },
    clear() { generation++; entries.clear(); bytes = 0 },
    async read(key: string, load: () => Promise<Uint8ClampedArray>, owner = generation) {
      const cached = owner === generation ? entries.get(key) : undefined
      if (cached) {
        entries.delete(key); entries.set(key, cached)
        // The caller transfers this buffer to the worker. Never detach the cache.
        return { pixels: cached.slice(), hit: true }
      }
      const pixels = await load(), cost = size(key, pixels)
      if (owner === generation && cost <= budget) {
        while (bytes + cost > budget && entries.size) {
          const oldest = entries.keys().next().value!
          bytes -= size(oldest, entries.get(oldest)!); entries.delete(oldest)
        }
        const previous = entries.get(key)
        if (previous) bytes -= size(key, previous)
        entries.set(key, pixels.slice()); bytes += cost
      }
      return { pixels, hit: false }
    },
  }
}

export type MotionAtlasCache = ReturnType<typeof createMotionAtlasCache>
