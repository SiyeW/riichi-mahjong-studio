import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import { getUiMotionDurationMs } from './uiMotion'
import { artworkPixelWidth, artworkWidthFitsBudget, maximumArtworkPixelWidth } from './tiles/artworkDemand'
import { artworkSourceHash, decodeArtwork, openArtworkCache, rasterizeTileArtwork, sufficientArtwork } from './tiles/artworkCache'

type Translate = (key: string, params?: Record<string, string | number>) => string

export function useTileArtwork(t: Translate, uiScale: Readonly<Ref<number>>) {
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
  const cachedSources = shallowRef<Record<string, string>>({})
  const requestedWidth = ref(0)
  let publishedWidth = 0
  let cachedImages: HTMLImageElement[] = []
  let disposed = false
  let prepared = false
  let preparing = false
  let quietUntil = 0
  let quietTimer = 0
  let idleRequest = 0
  let finishIdle: ((ready: boolean) => void) | null = null
  let densityQuery: MediaQueryList | null = null
  const fetchController = new AbortController()
  const artworkCache = openArtworkCache()
  const maximumWidth = maximumArtworkPixelWidth(tileArtworkSources.length)
  const retiredUrls = new Map<number, string[]>()

  function tileImageSrc(tile: string): string {
    const assetName = tileAssetName(tile)
    const assetPath = `./assets/tiles/Regular_shortnames/${assetName}.svg`
    const sourcePath = tileAssetModules[assetPath] ? assetPath : './assets/tiles/Regular_shortnames/back.svg'
    // Read the map even before the first publication so every Vue consumer
    // subscribes to the later atomic handoff, not just to viewport changes.
    const sources = cachedSources.value
    return (publishedWidth >= requestedWidth.value && sources[sourcePath]) || tileAssetModules[sourcePath]
  }

  function holdTileArtworkUpdates() {
    quietUntil = Math.max(quietUntil, performance.now() + getUiMotionDurationMs() + 50)
  }

  function waitForQuiet(): Promise<boolean> {
    return new Promise(resolve => {
      finishIdle = resolve
      const check = () => {
        if (disposed) { finishIdle = null; resolve(false); return }
        const delay = quietUntil - performance.now()
        if (delay > 0) {
          quietTimer = window.setTimeout(() => { quietTimer = 0; check() }, delay)
          return
        }
        idleRequest = window.requestIdleCallback(() => {
          idleRequest = 0
          if (performance.now() < quietUntil) { check(); return }
          finishIdle = null
          resolve(true)
        })
      }
      check()
    })
  }

  function retireSources(sources: Record<string, string>) {
    const urls = Object.values(sources)
    if (!urls.length) return
    const timer = window.setTimeout(() => {
      urls.forEach(url => URL.revokeObjectURL(url))
      retiredUrls.delete(timer)
    }, getUiMotionDurationMs() + 50)
    retiredUrls.set(timer, urls)
  }

  async function prepareCachedArtwork() {
    if (preparing || !prepared || disposed) return
    preparing = true
    try {
      while (!disposed && publishedWidth < requestedWidth.value
        && artworkWidthFitsBudget(requestedWidth.value, tileArtworkSources.length)) {
        const width = requestedWidth.value
        let coverage = maximumWidth
        const sources: Record<string, string> = {}
        const images: HTMLImageElement[] = []
        try {
          for (const [id, source] of Object.entries(tileAssetModules)) {
            if (!await waitForQuiet() || width < requestedWidth.value) break
            const response = await fetch(source, { signal: fetchController.signal })
            if (!response.ok) throw new Error('Artwork source unavailable')
            const hash = await artworkSourceHash(await response.text())
            let entry = await artworkCache.read(id)
            let url: string | undefined
            if (sufficientArtwork(entry, hash, width, maximumWidth) && entry.id === id) {
              url = URL.createObjectURL(entry.blob)
              try { images.push(await decodeArtwork(url)) }
              catch { URL.revokeObjectURL(url); url = undefined }
            }
            if (!url) {
              const image = await decodeArtwork(source)
              if (!await waitForQuiet()) break
              entry = await rasterizeTileArtwork(id, hash, image, width)
              url = URL.createObjectURL(entry.blob)
              try { images.push(await decodeArtwork(url)) }
              catch (error) { URL.revokeObjectURL(url); throw error }
              await artworkCache.write(entry)
            }
            sources[id] = url
            coverage = Math.min(coverage, entry?.pixelWidth || width)
          }
          if (disposed || width < requestedWidth.value || Object.keys(sources).length !== Object.keys(tileAssetModules).length) {
            Object.values(sources).forEach(url => URL.revokeObjectURL(url))
            continue
          }
          if (!await waitForQuiet()) {
            Object.values(sources).forEach(url => URL.revokeObjectURL(url))
            break
          }
          retireSources(cachedSources.value)
          cachedImages.length = 0
          cachedImages = images
          publishedWidth = coverage
          cachedSources.value = sources
        } catch {
          Object.values(sources).forEach(url => URL.revokeObjectURL(url))
          // Optional acceleration must never affect bootstrap or navigation.
          break
        }
      }
    } finally { preparing = false }
  }

  function recheckArtworkDemand() {
    if (disposed) return
    holdTileArtworkUpdates()
    const shell = document.querySelector('.shell') || document.body
    requestedWidth.value = artworkPixelWidth({
      screenWidth: window.screen.availWidth,
      screenHeight: window.screen.availHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      pixelRatio: window.devicePixelRatio || 1,
      uiTileWidth: 3 * Number.parseFloat(getComputedStyle(shell).fontSize),
    })
    void prepareCachedArtwork()
  }

  function watchPixelDensity() {
    densityQuery?.removeEventListener('change', watchPixelDensity)
    densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    densityQuery.addEventListener('change', watchPixelDensity)
    recheckArtworkDemand()
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
    prepared = true
    recheckArtworkDemand()
  }

  watch(uiScale, recheckArtworkDemand, { flush: 'post' })
  onMounted(() => {
    window.addEventListener('resize', recheckArtworkDemand)
    for (const event of ['wheel', 'pointerdown', 'keydown']) window.addEventListener(event, holdTileArtworkUpdates, { passive: true, capture: true })
    watchPixelDensity()
  })
  onBeforeUnmount(() => {
    disposed = true
    fetchController.abort()
    artworkCache.close()
    window.removeEventListener('resize', recheckArtworkDemand)
    for (const event of ['wheel', 'pointerdown', 'keydown']) window.removeEventListener(event, holdTileArtworkUpdates, true)
    densityQuery?.removeEventListener('change', watchPixelDensity)
    window.clearTimeout(quietTimer)
    window.cancelIdleCallback(idleRequest)
    finishIdle?.(false)
    finishIdle = null
    Object.values(cachedSources.value).forEach(url => URL.revokeObjectURL(url))
    for (const [timer, urls] of retiredUrls) {
      window.clearTimeout(timer)
      urls.forEach(url => URL.revokeObjectURL(url))
    }
    retiredUrls.clear()
    cachedImages = []
    preloadedTileImages.length = 0
  })

  return {
    tileArtworkReady,
    tileArtworkLoadingLabel,
    tileImageSrc,
    prepareTileArtwork,
    holdTileArtworkUpdates,
  }
}
