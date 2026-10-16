import assert from 'node:assert/strict'
import test from 'node:test'
import { stableForegroundSample, type MotionProbeSurface } from './motionProbeSurface.ts'

const surface = (): MotionProbeSurface => ({
  visible: true, focused: true, opacity: 1, mode: 'native', documentVisibility: 'visible',
  pixelRatio: 1, invalidations: 3, power: { idleState: 'active' },
  display: { id: 1, displayFrequency: 165, scaleFactor: 1 },
  bounds: { x: 0, y: 0, width: 2560, height: 1392 },
})

test('an unlocked stable native surface is eligible even without recent user input', () => {
  assert.equal(stableForegroundSample(surface(), surface()), true)
  const idle = surface(); idle.power.idleState = 'idle'
  assert.equal(stableForegroundSample(surface(), idle), true)
})

test('locked and unknown OS state invalidate either end of the sample', () => {
  for (const idleState of ['locked', 'unknown']) {
    const unavailable = surface(); unavailable.power.idleState = idleState
    assert.equal(stableForegroundSample(unavailable, surface()), false)
    assert.equal(stableForegroundSample(surface(), unavailable), false)
  }
})

test('losing and regaining foreground during the window cannot pass equal endpoint checks', () => {
  const after = surface(); after.invalidations++
  assert.equal(stableForegroundSample(surface(), after), false)
})

test('hidden, unfocused, transparent and layered diagnostic windows are ineligible', () => {
  for (const patch of [{ visible: false }, { focused: false }, { opacity: 0 },
    { mode: 'layered-diagnostic' }, { documentVisibility: 'hidden' }]) {
    assert.equal(stableForegroundSample(surface(), { ...surface(), ...patch }), false)
  }
})

test('display, geometry and density changes invalidate the sample', () => {
  const changes = [
    { pixelRatio: 1.5 }, { pixelRatio: 0 }, { display: { ...surface().display, id: 2 } },
    { display: { ...surface().display, displayFrequency: 60 } },
    { display: { ...surface().display, displayFrequency: 0 } },
    { display: { ...surface().display, scaleFactor: 1.5 } },
    { bounds: { ...surface().bounds, x: 1 } }, { bounds: { ...surface().bounds, width: 2000 } },
    { bounds: { ...surface().bounds, height: 0 } },
  ]
  for (const patch of changes) assert.equal(stableForegroundSample(surface(), { ...surface(), ...patch }), false)
})
