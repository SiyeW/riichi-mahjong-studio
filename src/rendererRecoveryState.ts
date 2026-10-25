/** Page-lifetime owner of the last root's pending-edit flush, including after a
 * failed hot replacement unmounts it. Never retain the whole record here. */
export function createRendererRecoveryState(reload: () => void) {
  let flush: (() => void | Promise<void>) | null = null
  let pending: Promise<void> | null = null
  return {
    setFlush(callback: () => void | Promise<void>) { flush = callback },
    recover(): Promise<void> {
      if (pending) return pending
      const callback = flush
      pending = Promise.resolve().then(async () => {
        await callback?.()
        reload()
      }).finally(() => { pending = null })
      return pending
    },
  }
}

export const rendererRecovery = createRendererRecoveryState(() => window.location.reload())
