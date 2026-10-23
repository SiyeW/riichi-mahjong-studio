import { createApp, h, nextTick, reactive, ref } from 'vue'
import '/src/styles.css'
import { useAutomaticAnalysis } from '/src/useAutomaticAnalysis.ts'

const status = reactive({ gameLoaded: true, autoAnalysis: {
  status: 'running', completed: 242, total: 534, cached: 0, analyzed: 242, failed: 0,
  currentNodeId: 'another-round-node', currentModel: 'opponent', message: '',
  timeline: 'o'.repeat(292) + 'O'.repeat(242), timelineReady: 242,
} })
const epoch = ref(0)
let model
const app = createApp({ setup() {
  model = useAutomaticAnalysis({ status, t: key => key, applyStatus: next => Object.assign(status, next) })
  return () => h('div', { class: 'auto-analysis-progress', style: 'position:relative;width:245px;height:30px' }, [
    h('canvas', { key: epoch.value, ref: model.autoAnalysisCanvasEl, style: 'position:absolute;width:100%;height:100%' }),
    h('small', { style: 'position:relative' }, model.autoAnalysisLabel.value),
  ])
} })
app.mount(document.querySelector('#fixture'))
const settle = async () => { await nextTick(); for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve)) }
function snapshot() {
  const canvas = model.autoAnalysisCanvasEl.value
  const data = canvas.getContext('2d').getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data
  return { width: canvas.width, expectedWidth: Math.round(canvas.getBoundingClientRect().width * devicePixelRatio),
    alpha: Array.from({ length: canvas.width }, (_, x) => data[x * 4 + 3]),
    percent: model.autoAnalysisPercent.value,
    label: document.querySelector('.auto-analysis-progress small').textContent }
}
window.automaticProgressFixture = {
  settle, snapshot,
  async progress(timeline, state = 'running') {
    const ready = [...timeline].filter(char => char === 'M' || char === 'O').length
    status.autoAnalysis = { ...status.autoAnalysis, timeline, timelineReady: ready, completed: ready, status: state }
    await settle(); return snapshot()
  },
  async replaceCanvas() { const old = model.autoAnalysisCanvasEl.value; epoch.value++; await settle(); return { ...snapshot(), replaced: old !== model.autoAnalysisCanvasEl.value, oldConnected: old.isConnected } },
  async resize(width) { document.querySelector('.auto-analysis-progress').style.width = `${width}px`; await settle(); return snapshot() },
  async unloaded() { status.gameLoaded = false; await settle(); return snapshot() },
  dispose() { app.unmount() },
}
