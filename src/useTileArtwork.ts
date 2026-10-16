import { computed, onBeforeUnmount, ref } from 'vue'
import { preloadArtworkSources, tileArtworkAssetName } from './tiles/artworkSources'
import { tileArtworkByName, tileArtworkSources } from './tiles/artworkCatalog'

type Translate = (key: string, params?: Record<string, string | number>) => string

export function useTileArtwork(t: Translate) {
  const sources = tileArtworkSources
  const tileArtworkReady = ref(false)
  const loadedCount = ref(0)
  const tileArtworkLoadingLabel = computed(() => t('common.loadingProgress', {
    completed: loadedCount.value,
    total: sources.length,
  }))
  let preloader: ReturnType<typeof preloadArtworkSources> | null = null
  let preparation: Promise<void> | null = null
  let disposed = false

  function tileImageSrc(tile: string): string {
    return tileArtworkByName[tileArtworkAssetName(tile)] || tileArtworkByName.back!
  }

  function prepareTileArtwork(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (preparation) return preparation
    // Keep one bounded set of decoded originals. Native image rendering owns
    // size/DPI rasterization; display never exports, redecodes or persists PNGs.
    preloader = preloadArtworkSources(sources, () => { loadedCount.value++ })
    preparation = preloader.ready.then(ready => {
      if (ready && !disposed) tileArtworkReady.value = true
    })
    return preparation
  }

  onBeforeUnmount(() => {
    disposed = true
    preloader?.dispose()
    preloader = null
  })

  return { tileArtworkReady, tileArtworkLoadingLabel, tileImageSrc, prepareTileArtwork }
}
