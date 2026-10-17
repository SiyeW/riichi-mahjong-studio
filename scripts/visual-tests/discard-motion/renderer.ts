import { captureMotionSnapshot, type MotionSnapshot } from '../../../src/discardMotion/snapshot'
import { integralFragment, integralVertex, rowIntegrals, rowSupport, ROW_INTEGRAL_PADDING } from '../../../src/discardMotion/integral'

// A controlled visual sampler. It shares Studio's pixels/shader, not its worker
// cadence; preview updates are never presented-FPS measurements.
export class PreviewRenderer {
  readonly canvas = document.createElement('canvas')
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private textures: WebGLTexture[] = []
  private uniforms: Record<string, WebGLUniformLocation | null>
  private snapshot: MotionSnapshot | null = null
  private retired = false
  ready = false
  constructor(parent: HTMLElement) {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })
    if (!gl) throw Error('WebGL2 unavailable')
    this.gl = gl
    const program = gl.createProgram()
    if (!program) { gl.getExtension('WEBGL_lose_context')?.loseContext(); throw Error('Program allocation failed') }
    this.program = program
    for (const [kind, source] of [[gl.VERTEX_SHADER, integralVertex], [gl.FRAGMENT_SHADER, integralFragment]] as const) {
      const shader = gl.createShader(kind)
      if (!shader) { gl.deleteProgram(program); gl.getExtension('WEBGL_lose_context')?.loseContext(); throw Error('Shader allocation failed') }
      gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader)
        gl.deleteShader(shader); gl.deleteProgram(program); gl.getExtension('WEBGL_lose_context')?.loseContext()
        throw Error(error || 'Shader failed')
      }
      gl.attachShader(program, shader); gl.deleteShader(shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program)
      gl.deleteProgram(program); gl.getExtension('WEBGL_lose_context')?.loseContext()
      throw Error(error || 'Link failed')
    }
    this.uniforms = Object.fromEntries(['planeA', 'planeB', 'product', 'sprite', 'viewport', 'axis', 'center', 'span', 'weights']
      .map(name => [name, gl.getUniformLocation(program, name)]))
    this.canvas.style.cssText = 'position:absolute;pointer-events:none;visibility:hidden'
    parent.append(this.canvas)
  }
  hide() { this.canvas.style.visibility = 'hidden' }
  async prepare(source: HTMLElement, effect: Animation, dx: number, dy: number) {
    this.ready = false; this.hide()
    const snapshot = await captureMotionSnapshot(source, [effect], dx, dy)
    if (this.retired) return
    const gl = this.gl, g = snapshot.geometry
    this.textures.forEach(texture => gl.deleteTexture(texture)); this.textures = []
    this.snapshot = snapshot; this.canvas.width = g.width; this.canvas.height = g.height
    // The snapshot was captured in the left pane. Preserve its pane-local
    // coordinates rather than subtracting the right pane's viewport origin.
    const origin = source.parentElement!, rect = origin.getBoundingClientRect()
    Object.assign(this.canvas.style, { left: `${snapshot.left - rect.left - origin.clientLeft}px`,
      top: `${snapshot.top - rect.top - origin.clientTop}px`, width: `${g.width / snapshot.dpr}px`, height: `${g.height / snapshot.dpr}px` })
    gl.useProgram(this.program); gl.viewport(0, 0, g.width, g.height)
    const u = (name: string) => this.uniforms[name]!
    const count = g.spriteWidth * g.spriteHeight * 4
    const support = rowSupport(snapshot.pixels.subarray(0, count), g.spriteWidth, g.spriteHeight,
      snapshot.planeCount === 2 ? snapshot.pixels.subarray(count) : undefined)
    for (let index = 0; index < snapshot.planeCount; index++) {
      const texture = gl.createTexture()!; this.textures.push(texture)
      gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, g.spriteWidth + ROW_INTEGRAL_PADDING, g.spriteHeight, 0, gl.RGBA, gl.FLOAT,
        rowIntegrals(snapshot.pixels.subarray(index * count, (index + 1) * count), g.spriteWidth, g.spriteHeight, undefined, support))
      gl.uniform1i(u(index ? 'planeB' : 'planeA'), index)
    }
    gl.uniform1i(u('product'), 0)
    gl.uniform2f(u('sprite'), g.spriteWidth, g.spriteHeight); gl.uniform2f(u('viewport'), g.width, g.height); gl.uniform2f(u('axis'), g.axisX, g.axisY)
    if (gl.getError() !== gl.NO_ERROR) throw Error('Motion preparation failed')
    this.ready = true
    this.draw(0, 0, 0); this.hide()
  }
  draw(progress: number, previous: number, backOpacity: number) {
    if (!this.ready || !this.snapshot || this.retired || this.gl.isContextLost()) return false
    const gl = this.gl, g = this.snapshot.geometry, u = (name: string) => this.uniforms[name]!
    gl.useProgram(this.program)
    gl.uniform2f(u('center'), g.startX + g.dx * progress, g.startY + g.dy * progress)
    gl.uniform1f(u('span'), Math.hypot(g.dx, g.dy) * (progress - previous))
    gl.uniform3f(u('weights'), 1 - backOpacity, backOpacity, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.canvas.style.visibility = 'visible'
    return true
  }
  dispose() {
    if (this.retired) return
    this.retired = true; this.ready = false; this.snapshot = null
    this.textures.forEach(texture => this.gl.deleteTexture(texture)); this.textures = []
    this.gl.deleteProgram(this.program); this.gl.getExtension('WEBGL_lose_context')?.loseContext(); this.canvas.remove()
  }
}
