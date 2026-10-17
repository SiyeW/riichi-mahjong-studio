import { parseCssEasing } from '../motionCurve'
import { integralFragment, integralVertex, opacityAt, rowIntegrals, rowSupport, ROW_INTEGRAL_PADDING } from './integral'
import type { MotionRequest, MotionReply, SubmittedInterval } from './messages'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MotionRequest>) => void) | null
  postMessage(message: MotionReply): void
  requestAnimationFrame(callback: FrameRequestCallback): number
  cancelAnimationFrame(id: number): void
}
let canvas: OffscreenCanvas, gl: WebGL2RenderingContext, program: WebGLProgram
const uniformNames = ['planeA', 'planeB', 'product', 'sprite', 'viewport', 'center', 'axis', 'span', 'weights'] as const
let uniforms: Record<typeof uniformNames[number], WebGLUniformLocation | null>, maxTextureSize = 0, usable = false
let textures: WebGLTexture[] = [], fence: WebGLSync | null = null, frame = 0
let retirementTimer: ReturnType<typeof setTimeout> | null = null, retiringSince = 0
let job: Omit<Extract<MotionRequest, { type: 'prepare' }>, 'pixels'> | null = null
let previous = 0, previousTime = 0, started = 0, phase: 'motion' | 'sharp' | 'finish' = 'motion'
let intervals: SubmittedInterval[] = []
let ease = (value: number) => value

function release() {
  if (frame) scope.cancelAnimationFrame(frame)
  frame = 0
  job = null
  // Deleting a sync object does not cancel the submitted GPU work. Retain its
  // fence/textures until completion, and reject another preparation while it is
  // draining so rapid supersession cannot build a hidden GPU queue.
  if (usable && fence) {
    try {
      if (!fenceReady()) {
        if (!retiringSince) retiringSince = performance.now()
        if (performance.now() - retiringSince <= 500) {
          if (retirementTimer === null) {
            const retiringFence = fence
            const timer = setTimeout(() => {
              if (retirementTimer !== timer) return
              retirementTimer = null
              if (fence !== retiringFence || job) return
              release()
              if (!usable) scope.postMessage({ type: 'failed', id: 0, reason: 'GPU retirement failed' })
            }, 4)
            retirementTimer = timer
          }
          return
        }
        usable = false
      }
    } catch { usable = false }
  }
  if (retirementTimer !== null) clearTimeout(retirementTimer)
  retirementTimer = null; retiringSince = 0
  if (fence) gl.deleteSync(fence)
  fence = null
  textures.forEach(texture => gl.deleteTexture(texture)); textures = []
}

function failed(reason: unknown, id = job?.id ?? 0) {
  release()
  scope.postMessage({ type: 'failed', id: usable ? id : 0, reason: String(reason) })
}

function compile(kind: number, source: string) {
  const shader = gl.createShader(kind)
  if (!shader) throw Error('Motion shader allocation failed')
  gl.shaderSource(shader, source); gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw Error(error || 'Motion shader failed')
  }
  return shader
}

function initialize(surface: OffscreenCanvas) {
  canvas = surface
  const context = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })
  if (!context || typeof scope.requestAnimationFrame !== 'function') throw Error('Worker WebGL2/rAF unavailable')
  gl = context
  const vertex = compile(gl.VERTEX_SHADER, integralVertex), fragment = compile(gl.FRAGMENT_SHADER, integralFragment)
  const linked = gl.createProgram()
  if (!linked) throw Error('Motion program allocation failed')
  program = linked
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
  gl.deleteShader(vertex); gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) || 'Motion link failed')
  gl.useProgram(program)
  uniforms = Object.fromEntries(uniformNames.map(name => [name, gl.getUniformLocation(program, name)])) as typeof uniforms
  maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
  usable = true
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); usable = false; failed('Motion context lost', 0) })
  // Link completion is not first-draw readiness, especially in software WebGL.
  // Reuse the real preparation path with a reserved tiny warm job, off-flight.
  void prepare({ type: 'prepare', id: 0, geometry: { width: 1, height: 1, spriteWidth: 2, spriteHeight: 2,
    startX: .5, startY: .5, dx: 1, dy: 0, axisX: 1, axisY: 0 }, pixels: new Uint8ClampedArray(32).fill(255), planeCount: 2, mode: 'crossfade',
    stops: [[{offset:0,value:1}], [{offset:0,value:1}]], duration: 1, easing: 'linear' })
}

function texture(data: Float32Array, unit: number, name: 'planeA' | 'planeB' | 'product') {
  const created = gl.createTexture()
  if (!created || !job) throw Error('Motion texture allocation failed')
  textures.push(created)
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, created)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, job.geometry.spriteWidth + ROW_INTEGRAL_PADDING, job.geometry.spriteHeight, 0, gl.RGBA, gl.FLOAT, data)
  gl.uniform1i(uniforms[name], unit)
}

function draw(progress: number, last: number, time: number) {
  if (!job) return
  const g = job.geometry, span = Math.hypot(g.dx, g.dy) * (progress - last)
  const p = Math.max(0, Math.min(1, (time - started) / job.duration))
  let weights: [number, number, number] = [1, 0, 0]
  if (job.mode === 'overlay') {
    const b = opacityAt(job.stops[0]!, p); weights = [1 - b, b, 0]
  } else if (job.mode === 'crossfade') {
    const a = opacityAt(job.stops[0]!, p), b = opacityAt(job.stops[1]!, p)
    weights = [a, b, a * b]
  }
  gl.uniform2f(uniforms.center, g.startX + g.dx * progress, g.startY + g.dy * progress)
  gl.uniform1f(uniforms.span, span)
  gl.uniform3f(uniforms.weights, ...weights)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
  if (!fence) { usable = false; throw Error('Motion fence allocation failed') }
  gl.flush()
  intervals.push({ fromTime: previousTime, time, previous: last, progress, span })
}

function fenceReady() {
  if (!fence) return true
  const state = gl.clientWaitSync(fence, 0, 0)
  if (state === gl.WAIT_FAILED) throw Error('Motion fence failed')
  if (state === gl.TIMEOUT_EXPIRED) return false
  gl.deleteSync(fence); fence = null
  return true
}

function tick() {
  frame = 0
  if (!job) return
  try {
    // Freeze one time endpoint. Work done below never extends its own sweep.
    const time = Math.max(started, previousTime, performance.timeOrigin + performance.now())
    if (time - started > job.duration + 500) throw Error('Motion submission timed out')
    if (fenceReady()) {
      if (phase === 'finish') {
        const id = job.id, submitted = intervals
        release(); scope.postMessage({ type: 'done', id, intervals: submitted }); return
      }
      const progress = phase === 'sharp' ? 1 : ease(Math.max(0, Math.min(1, (time - started) / job.duration)))
      if (progress < previous || progress < 0 || progress > 1) throw Error('Unsupported nonmonotone flight')
      draw(progress, phase === 'sharp' ? 1 : previous, time)
      previous = progress; previousTime = time
      if (phase === 'sharp') phase = 'finish'
      else if (progress === 1) phase = 'sharp'
    }
    frame = scope.requestAnimationFrame(tick)
  } catch (error) { failed(error) }
}

async function prepare(request: Extract<MotionRequest, { type: 'prepare' }>) {
  release()
  if (!usable || fence) {
    scope.postMessage({ type: 'failed', id: usable ? request.id : 0, reason: 'Previous GPU draw still retiring' })
    return
  }
  const before = performance.now()
  const { pixels, ...prepared } = request
  job = prepared
  try {
    const g = request.geometry
    if (![g.width, g.height, g.spriteWidth, g.spriteHeight].every(n => Number.isInteger(n) && n > 0 && n < maxTextureSize)
      || g.spriteWidth + ROW_INTEGRAL_PADDING > maxTextureSize
      || g.width * g.height > 4_000_000 || g.spriteWidth * g.spriteHeight > 1_000_000) throw Error('Motion surface exceeds bounded size')
    const parsed = parseCssEasing(request.easing)
    if (!parsed) throw Error('Unsupported motion easing')
    ease = parsed
    canvas.width = g.width; canvas.height = g.height
    gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(program)
    gl.uniform2f(uniforms.sprite, g.spriteWidth, g.spriteHeight)
    gl.uniform2f(uniforms.viewport, g.width, g.height)
    gl.uniform2f(uniforms.axis, g.axisX, g.axisY)
    const planeBytes = g.spriteWidth * g.spriteHeight * 4
    if (request.planeCount !== (request.mode === 'single' ? 1 : 2)
      || pixels.length !== planeBytes * request.planeCount) throw Error('Invalid motion pixel atlas')
    const a = pixels.subarray(0, planeBytes), b = request.planeCount === 2 ? pixels.subarray(planeBytes) : a
    // All compositing terms use one union support, preserving source-over
    // linearity when face, back and the riichi hand pose have different bounds.
    const support = rowSupport(a, g.spriteWidth, g.spriteHeight, b)
    texture(rowIntegrals(a, g.spriteWidth, g.spriteHeight, undefined, support), 0, 'planeA')
    if (request.mode !== 'single') texture(rowIntegrals(b, g.spriteWidth, g.spriteHeight, undefined, support), 1, 'planeB')
    else gl.uniform1i(uniforms.planeB, 0)
    if (request.mode === 'crossfade') texture(rowIntegrals(a, g.spriteWidth, g.spriteHeight, b, support), 2, 'product')
    else gl.uniform1i(uniforms.product, 0)
    previous = 0; started = performance.timeOrigin + performance.now(); previousTime = started; phase = 'motion'; intervals = []
    draw(0, 0, started)
    const id = request.id
    const ready = () => {
      if (job?.id !== id) return
      try {
        if (performance.now() - before > 500) throw Error('Motion preparation timed out')
        if (!fenceReady()) { setTimeout(ready, 0); return }
        // Check capability/upload/draw errors once, after preparation's fence.
        // getError is a synchronous command-buffer round trip in Chromium; it
        // must not serialize each submitted animation frame with the GPU.
        if (gl.getError() !== gl.NO_ERROR) throw Error('Motion preparation draw failed')
        intervals = []
        if (id === 0) { release(); scope.postMessage({ type: 'warm' }) }
        else scope.postMessage({ type: 'ready', id, preparationMs: performance.now() - before })
      } catch (error) { failed(error) }
    }
    ready()
  } catch (error) { failed(error, request.id) }
}

scope.onmessage = event => {
  const message = event.data
  try {
    if (message.type === 'init') initialize(message.canvas)
    else if (message.type === 'prepare') void prepare(message)
    else if (message.type === 'cancel') {
      if (job?.id === message.id) release()
      if (!usable) scope.postMessage({ type: 'failed', id: 0, reason: 'GPU cancellation failed' })
    }
    else if (message.type === 'start' && job?.id === message.id) {
      started = message.absoluteTime; previousTime = started; previous = 0; phase = 'motion'
      frame = scope.requestAnimationFrame(tick)
    }
  } catch (error) { failed(error, 'id' in message ? message.id : 0) }
}
