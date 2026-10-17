import '../../../src/discardMotion/renderer.worker.ts'

// Test the worker's actual unsupported-capability path. Browser-level disable
// flags can report WebGL off while still permitting an OffscreenCanvas context.
const getContext = OffscreenCanvas.prototype.getContext
OffscreenCanvas.prototype.getContext = function (kind, ...options) {
  return kind === 'webgl2' ? null : getContext.call(this, kind, ...options)
}
