import { parseCssEasing } from '../motionCurve'
import { integralFragment, integralVertex, opacityAt, rowIntegrals } from './integral'
import type { MotionRequest, MotionReply, SubmittedInterval } from './messages'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MotionRequest>) => void) | null
  postMessage(message: MotionReply): void
  requestAnimationFrame(callback: FrameRequestCallback): number
  cancelAnimationFrame(id: number): void
}
let canvas: OffscreenCanvas, gl: WebGL2RenderingContext, program: WebGLProgram
let textures: WebGLTexture[] = [], fence: WebGLSync | null = null, frame = 0
let job: Extract<MotionRequest, { type: 'prepare' }> | null = null
let previous = 0, started = 0, phase: 'motion' | 'sharp' | 'finish' = 'motion'
let intervals: SubmittedInterval[] = []
let ease = (value: number) => value

function release() {
  if (frame) scope.cancelAnimationFrame(frame)
  frame = 0
  if (fence) gl.deleteSync(fence)
  fence = null
  textures.forEach(texture => gl.deleteTexture(texture)); textures = []
  job = null
}

function failed(reason: unknown, id = job?.id ?? 0) {
  release()
  scope.postMessage({ type: 'failed', id, reason: String(reason) })
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
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); failed('Motion context lost') })
  // Link completion is not first-draw readiness, especially in software WebGL.
  // Reuse the real preparation path with a reserved tiny warm job, off-flight.
  const staging = new OffscreenCanvas(2, 2), context2d = staging.getContext('2d', { willReadFrequently: true })
  if (!context2d) throw Error('Motion warm surface unavailable')
  context2d.fillStyle = '#fff'; context2d.fillRect(0, 0, 2, 2)
  const a = staging.transferToImageBitmap()
  context2d.fillRect(0, 0, 2, 2)
  const b = staging.transferToImageBitmap()
  void prepare({ type: 'prepare', id: 0, geometry: { width: 1, height: 1, spriteWidth: 2, spriteHeight: 2,
    startX: .5, startY: .5, dx: 1, dy: 0, axisX: 1, axisY: 0 }, planes: [a,b], mode: 'crossfade',
    stops: [[{offset:0,value:1}], [{offset:0,value:1}]], duration: 1, easing: 'linear' })
}

function texture(data: Float32Array, unit: number, name: string) {
  const created = gl.createTexture()
  if (!created || !job) throw Error('Motion texture allocation failed')
  textures.push(created)
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, created)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, job.geometry.spriteWidth + 1, job.geometry.spriteHeight, 0, gl.RGBA, gl.FLOAT, data)
  gl.uniform1i(gl.getUniformLocation(program, name), unit)
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
  gl.uniform2f(gl.getUniformLocation(program, 'center'), g.startX + g.dx * progress, g.startY + g.dy * progress)
  gl.uniform1f(gl.getUniformLocation(program, 'span'), span)
  gl.uniform3f(gl.getUniformLocation(program, 'weights'), ...weights)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
  if (!fence || gl.getError() !== gl.NO_ERROR) throw Error('Motion draw failed')
  gl.flush()
  intervals.push({ time, previous: last, progress, span })
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
    const time = performance.timeOrigin + performance.now()
    if (time - started > job.duration + 500) throw Error('Motion submission timed out')
    if (fenceReady()) {
      if (phase === 'finish') {
        const id = job.id, submitted = intervals
        release(); scope.postMessage({ type: 'done', id, intervals: submitted }); return
      }
      const progress = phase === 'sharp' ? 1 : ease(Math.max(0, Math.min(1, (time - started) / job.duration)))
      if (progress < previous || progress < 0 || progress > 1) throw Error('Unsupported nonmonotone flight')
      draw(progress, phase === 'sharp' ? 1 : previous, time)
      previous = progress
      if (phase === 'sharp') phase = 'finish'
      else if (progress === 1) phase = 'sharp'
    }
    frame = scope.requestAnimationFrame(tick)
  } catch (error) { failed(error) }
}

async function prepare(request: Extract<MotionRequest, { type: 'prepare' }>) {
  release()
  const before = performance.now()
  job = request
  try {
    const g = request.geometry, max = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    if (![g.width, g.height, g.spriteWidth, g.spriteHeight].every(n => Number.isInteger(n) && n > 0 && n < max)
      || g.width * g.height > 4_000_000 || g.spriteWidth * g.spriteHeight > 1_000_000) throw Error('Motion surface exceeds bounded size')
    ease = parseCssEasing(request.easing) ?? (() => { throw Error('Unsupported motion easing') })
    canvas.width = g.width; canvas.height = g.height
    gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(program)
    gl.uniform2f(gl.getUniformLocation(program, 'sprite'), g.spriteWidth, g.spriteHeight)
    gl.uniform2f(gl.getUniformLocation(program, 'viewport'), g.width, g.height)
    gl.uniform2f(gl.getUniformLocation(program, 'axis'), g.axisX, g.axisY)
    const scratch = new OffscreenCanvas(g.spriteWidth, g.spriteHeight)
    const context = scratch.getContext('2d', { willReadFrequently: true })
    if (!context) throw Error('Motion snapshot readback unavailable')
    const planes = request.planes.map(bitmap => {
      context.clearRect(0, 0, scratch.width, scratch.height); context.drawImage(bitmap, 0, 0)
      return context.getImageData(0, 0, scratch.width, scratch.height).data
    })
    const a = planes[0], b = planes[1] ?? a
    if (!a) throw Error('Empty motion snapshot')
    texture(rowIntegrals(a, g.spriteWidth, g.spriteHeight), 0, 'planeA')
    if (request.mode !== 'single') texture(rowIntegrals(b, g.spriteWidth, g.spriteHeight), 1, 'planeB')
    else gl.uniform1i(gl.getUniformLocation(program, 'planeB'), 0)
    if (request.mode === 'crossfade') texture(rowIntegrals(a, g.spriteWidth, g.spriteHeight, b), 2, 'product')
    else gl.uniform1i(gl.getUniformLocation(program, 'product'), 0)
    previous = 0; started = performance.timeOrigin + performance.now(); phase = 'motion'; intervals = []
    draw(0, 0, started)
    const id = request.id
    const ready = () => {
      if (job?.id !== id) return
      try {
        if (performance.now() - before > 500) throw Error('Motion preparation timed out')
        if (!fenceReady()) { setTimeout(ready, 0); return }
        intervals = []
        if (id === 0) { release(); scope.postMessage({ type: 'warm' }) }
        else scope.postMessage({ type: 'ready', id, preparationMs: performance.now() - before })
      } catch (error) { failed(error) }
    }
    ready()
  } catch (error) { failed(error, request.id) }
  finally { request.planes.forEach(bitmap => bitmap.close()) }
}

scope.onmessage = event => {
  const message = event.data
  try {
    if (message.type === 'init') initialize(message.canvas)
    else if (message.type === 'prepare') void prepare(message)
    else if (message.type === 'cancel') { if (job?.id === message.id) release() }
    else if (message.type === 'start' && job?.id === message.id) {
      started = message.absoluteTime; previous = 0; phase = 'motion'
      frame = scope.requestAnimationFrame(tick)
    }
  } catch (error) { failed(error, 'id' in message ? message.id : 0) }
}
