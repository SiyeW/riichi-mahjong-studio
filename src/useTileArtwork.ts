import { computed, ref } from 'vue'

type Translate = (key: string, params?: Record<string, string | number>) => string

export function useTileArtwork(t: Translate) {
  function tileAssetName(tile: string): string {
    if (!tile || tile === '?') return 'back'
    const normalized = tile.replace('r', '')
    const honorMap: Record<string, string> = {
      E: '1z', S: '2z', W: '3z', N: '4z', P: '5z', F: '6z', C: '7z',
    }
    if (honorMap[normalized]) return honorMap[normalized]
    const rank = normalized[0]
    const suit = normalized[1]
    if (rank === '5' && tile.endsWith('r')) return `0${suit}`
    return `${rank}${suit}`
  }

  const tileAssetModules = import.meta.glob('./assets/tiles/Regular_shortnames/*.svg', {
    eager: true,
    import: 'default',
  }) as Record<string, string>

  const tileArtworkSources = Array.from(new Set(Object.values(tileAssetModules).filter(Boolean)))
  const tileArtworkReady = ref(false)
  const tileArtworkLoadedCount = ref(0)
  const tileArtworkLoadingLabel = computed(() => (
    t('common.loadingProgress', {
      completed: tileArtworkLoadedCount.value,
      total: tileArtworkSources.length,
    })
  ))
  const preloadedTileImages: HTMLImageElement[] = []
  let staticAssetsWarmupPromise: Promise<void> | null = null

  function tileImageSrc(tile: string): string {
    const assetName = tileAssetName(tile)
    const assetPath = `./assets/tiles/Regular_shortnames/${assetName}.svg`
    return tileAssetModules[assetPath] || tileAssetModules['./assets/tiles/Regular_shortnames/back.svg']
  }

  function preloadTileImage(src: string): Promise<void> {
    const image = new Image()
    image.decoding = 'async'
    preloadedTileImages.push(image)

    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        tileArtworkLoadedCount.value += 1
        resolve()
      }
      const loaded = () => {
        // Loading is sufficient to populate the shared SVG cache. Decoding may
        // continue without holding up the renderer's first usable frame.
        if (typeof image.decode === 'function') {
          void image.decode().catch(() => undefined)
        }
        finish()
      }

      image.addEventListener('load', loaded, { once: true })
      image.addEventListener('error', finish, { once: true })
      image.src = src
      if (image.complete) {
        if (image.naturalWidth > 0) loaded()
        else finish()
      }
    })
  }

  function warmStaticAssets(): Promise<void> {
    if (staticAssetsWarmupPromise) return staticAssetsWarmupPromise
    staticAssetsWarmupPromise = Promise.all(tileArtworkSources.map(preloadTileImage)).then(() => undefined)
    return staticAssetsWarmupPromise
  }

  function nextPaint(): Promise<void> {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve())
    })
  }

  async function prepareTileArtwork() {
    await warmStaticAssets()
    await nextPaint()
    tileArtworkReady.value = true
  }

  return {
    tileArtworkReady,
    tileArtworkLoadingLabel,
    tileImageSrc,
    prepareTileArtwork,
  }
}
