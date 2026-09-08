import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TranslationParams } from './i18n'

type Translate = (key: string, params?: TranslationParams) => string

interface UseAutomaticAnalysisOptions {
  status: TrainerStatusSnapshot
  t: Translate
  applyStatus: (status: TrainerStatusSnapshot) => void
}

export function autoAnalysisLineColor(state: string): string | null {
  if (state === 'r' || state === 's') return 'rgb(143 121 82)'
  if (state === 'M' || state === 'O') return 'rgb(77 102 107)'
  return null
}

export function useAutomaticAnalysis(options: UseAutomaticAnalysisOptions) {
  const { status, t, applyStatus } = options
  const autoAnalysisRequestInFlight = ref(false)
  const autoAnalysisCanvasEl = ref<HTMLCanvasElement | null>(null)
  let autoAnalysisCanvasRaf = 0
  let autoAnalysisResizeObserver: ResizeObserver | null = null

  const autoAnalysisRunning = computed(() => status.autoAnalysis.status === 'running')
  const autoAnalysisTimeline = computed(() => status.autoAnalysis.timeline || '')
  const autoAnalysisTimelineTotal = computed(() => autoAnalysisTimeline.value.length)
  const autoAnalysisPercent = computed(() => {
    const total = autoAnalysisTimelineTotal.value
    const completed = Math.max(0, Number(status.autoAnalysis.timelineReady) || 0)
    if (!total) return status.autoAnalysis.status === 'completed' ? 100 : 0
    return Math.round(Math.min(1, completed / total) * 100)
  })
  const autoAnalysisLabel = computed(() => {
    const { status: state, failed } = status.autoAnalysis
    const completed = Math.max(0, Number(status.autoAnalysis.timelineReady) || 0)
    const total = autoAnalysisTimelineTotal.value
    if (!status.gameLoaded) return t('autoAnalysis.noRecord')
    if (state === 'running') return total ? `${completed} / ${total}` : t('autoAnalysis.scanning')
    if (state === 'completed') return failed
      ? t('autoAnalysis.failedCount', { completed, total, failed })
      : (total ? `${completed} / ${total}` : t('autoAnalysis.notNeeded'))
    if (state === 'canceled') return total
      ? t('autoAnalysis.stoppedProgress', { completed, total })
      : t('autoAnalysis.stopped')
    return total ? `${completed} / ${total}` : t('autoAnalysis.notStarted')
  })

  function prepareAutoAnalysisCanvas(canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.max(1, window.devicePixelRatio || 1)
    const width = Math.max(1, Math.round(rect.width * ratio))
    const height = Math.max(1, Math.round(rect.height * ratio))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    return { context: canvas.getContext('2d'), width, height }
  }

  function drawAutoAnalysisMainCanvas() {
    const canvas = autoAnalysisCanvasEl.value
    if (!canvas) return
    const { context, width, height } = prepareAutoAnalysisCanvas(canvas)
    if (!context) return
    context.clearRect(0, 0, width, height)
    const timeline = autoAnalysisTimeline.value
    if (!timeline.length) return

    const slotWidth = width / timeline.length
    if (slotWidth >= 1) {
      for (let index = 0; index < timeline.length; index += 1) {
        const x = Math.floor(index * slotWidth)
        const nextX = Math.floor((index + 1) * slotWidth)
        const color = autoAnalysisLineColor(timeline[index])
        if (!color) continue
        context.fillStyle = color
        context.fillRect(x, 0, Math.max(1, nextX - x), height)
      }
      return
    }

    for (let x = 0; x < width; x += 1) {
      const start = Math.floor((x * timeline.length) / width)
      const end = Math.max(start + 1, Math.floor(((x + 1) * timeline.length) / width))
      let ready = 0
      let active = false
      for (let index = start; index < Math.min(end, timeline.length); index += 1) {
        const state = timeline[index]
        if (state === 'M' || state === 'O') ready += 1
        if (state === 'r' || state === 's') active = true
      }
      if (active) context.fillStyle = 'rgb(143 121 82)'
      else {
        const density = ready / Math.max(1, end - start)
        if (density <= 0) continue
        context.fillStyle = `rgba(77, 102, 107, ${density})`
      }
      context.fillRect(x, 0, 1, height)
    }
  }

  function scheduleAutoAnalysisCanvasDraw() {
    if (autoAnalysisCanvasRaf) return
    autoAnalysisCanvasRaf = window.requestAnimationFrame(() => {
      autoAnalysisCanvasRaf = 0
      drawAutoAnalysisMainCanvas()
    })
  }

  watch(autoAnalysisTimeline, scheduleAutoAnalysisCanvasDraw)
  async function toggleAutoAnalysis() {
    if (!window.trainerAPI || !status.gameLoaded || autoAnalysisRequestInFlight.value) return
    autoAnalysisRequestInFlight.value = true
    try {
      const response = autoAnalysisRunning.value
        ? await window.trainerAPI.cancelAutoAnalysis()
        : await window.trainerAPI.startAutoAnalysis()
      applyStatus(response.state)
    } catch (error) {
      status.autoAnalysis = {
        ...status.autoAnalysis,
        status: 'canceled',
        currentNodeId: null,
        currentModel: null,
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      autoAnalysisRequestInFlight.value = false
    }
  }

  onMounted(() => {
    autoAnalysisResizeObserver = new ResizeObserver(scheduleAutoAnalysisCanvasDraw)
    if (autoAnalysisCanvasEl.value) autoAnalysisResizeObserver.observe(autoAnalysisCanvasEl.value)
    scheduleAutoAnalysisCanvasDraw()
  })

  onBeforeUnmount(() => {
    autoAnalysisResizeObserver?.disconnect()
    autoAnalysisResizeObserver = null
    if (autoAnalysisCanvasRaf) {
      cancelAnimationFrame(autoAnalysisCanvasRaf)
      autoAnalysisCanvasRaf = 0
    }
  })

  return {
    autoAnalysisCanvasEl,
    autoAnalysisLabel,
    autoAnalysisPercent,
    autoAnalysisRequestInFlight,
    autoAnalysisRunning,
    scheduleAutoAnalysisCanvasDraw,
    toggleAutoAnalysis,
  }
}
