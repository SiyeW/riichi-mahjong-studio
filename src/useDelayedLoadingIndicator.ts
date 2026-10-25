import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

// A delay belongs to one uninterrupted wait, not to the requests replacing it.
export function createDelayedLoadingIndicator(change: (visible: boolean) => void, delay = 500) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false, visible = false, disposed = false
  const show = (next: boolean) => {
    if (visible === next) return
    visible = next
    change(next)
  }
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null }
  const reset = () => { pending = false; clearTimer(); show(false) }
  return {
    update(nextPending: boolean, hasContent: boolean) {
      if (disposed) return
      pending = nextPending
      if (!pending) { reset(); return }
      if (!hasContent) { clearTimer(); show(true); return }
      if (visible || timer !== null) return
      timer = setTimeout(() => { timer = null; if (pending && !disposed) show(true) }, delay)
    },
    reset,
    dispose() { disposed = true; reset() },
  }
}

export function useDelayedLoadingIndicator(pending: Readonly<Ref<boolean>>, hasContent: Readonly<Ref<boolean>>) {
  const visible = ref(false)
  const indicator = createDelayedLoadingIndicator(value => { visible.value = value })
  const refresh = () => indicator.update(pending.value, hasContent.value)
  watch([pending, hasContent], refresh, { immediate: true })
  onBeforeUnmount(indicator.dispose)
  return { visible, refresh, reset: indicator.reset }
}
