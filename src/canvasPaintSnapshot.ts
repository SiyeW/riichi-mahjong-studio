import { onBeforeUnmount } from 'vue'

export function createCanvasPaintSnapshot<T>(
  canvas: HTMLCanvasElement,
  property: string,
  format: (state: T) => string,
) {
  let state: T | undefined
  let hasState = false
  let formatted: string | undefined
  let disposed = false
  const read = () => {
    if (disposed || !hasState) return undefined
    if (formatted === undefined) {
      formatted = format(state as T)
    }
    return formatted
  }
  Object.defineProperty(canvas, property, { configurable: true, enumerable: true, get: read })
  return {
    // Drawing buffers are replaced, not mutated, after publication. Retain only
    // the last submitted state; probes pay for its derived string when reading.
    publish(value: T) {
      if (disposed) return
      state = value
      hasState = true
      formatted = undefined
    },
    dispose() {
      disposed = true
      state = undefined
      hasState = false
      formatted = undefined
      // A retired owner must not remove a replacement owner's getter during HMR.
      if (Object.getOwnPropertyDescriptor(canvas, property)?.get === read) Reflect.deleteProperty(canvas, property)
    },
  }
}

export function useCanvasPaintSnapshots<T>(property: string, format: (state: T) => string) {
  const snapshots = new Map<HTMLCanvasElement, ReturnType<typeof createCanvasPaintSnapshot<T>>>()
  let disposed = false
  onBeforeUnmount(() => {
    disposed = true
    snapshots.forEach(snapshot => snapshot.dispose())
    snapshots.clear()
  })
  function publish(canvas: HTMLCanvasElement, state: T) {
    if (disposed) return
    let snapshot = snapshots.get(canvas)
    if (!snapshot) {
      // Layout mode changes can replace canvas nodes without replacing their
      // component. Prune retired nodes on registration, not on every draw.
      for (const [oldCanvas, oldSnapshot] of snapshots) {
        if (!oldCanvas.isConnected) { oldSnapshot.dispose(); snapshots.delete(oldCanvas) }
      }
      snapshot = createCanvasPaintSnapshot(canvas, property, format)
      snapshots.set(canvas, snapshot)
    }
    snapshot.publish(state)
  }
  function retire(canvas: HTMLCanvasElement) {
    const snapshot = snapshots.get(canvas)
    if (!snapshot) return
    // Vue can reset a callback ref and restore the same node in one patch.
    // Retire only after that patch actually removed the node.
    queueMicrotask(() => {
      if (disposed || canvas.isConnected || snapshots.get(canvas) !== snapshot) return
      snapshot.dispose()
      snapshots.delete(canvas)
    })
  }
  return { publish, retire }
}
