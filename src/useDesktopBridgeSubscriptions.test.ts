import assert from 'node:assert/strict'
import test from 'node:test'
import { subscribeDesktopBridge } from './useDesktopBridgeSubscriptions.ts'

test('desktop bridge subscriptions forward handlers and clean every listener once', () => {
  const registered: Record<string, (...args: never[]) => unknown> = {}
  const cleanupCalls: string[] = []
  const api = Object.fromEntries([
    ['onPythonEvent', 'pythonEvent'],
    ['onRecordDirtyChanged', 'recordDirtyChanged'],
    ['onUiZoomShortcut', 'uiZoomShortcut'],
    ['onBeforeClose', 'beforeClose'],
  ].map(([method, handler]) => [method, (callback: (...args: never[]) => unknown) => {
    registered[handler] = callback
    return () => { cleanupCalls.push(handler) }
  }])) as unknown as NonNullable<Window['studioAPI']>
  const calls: string[] = []
  const unsubscribe = subscribeDesktopBridge(api, {
    pythonEvent: () => { calls.push('python') },
    recordDirtyChanged: () => { calls.push('dirty') },
    uiZoomShortcut: () => { calls.push('zoom') },
    beforeClose: () => { calls.push('close') },
  })

  registered.pythonEvent()
  registered.recordDirtyChanged()
  registered.uiZoomShortcut()
  registered.beforeClose()
  assert.deepEqual(calls, ['python', 'dirty', 'zoom', 'close'])

  unsubscribe()
  unsubscribe()
  assert.deepEqual(cleanupCalls.sort(), ['beforeClose', 'pythonEvent', 'recordDirtyChanged', 'uiZoomShortcut'].sort())
})

test('desktop bridge subscription tolerates an unavailable bridge', () => {
  const unsubscribe = subscribeDesktopBridge(undefined, {
    pythonEvent: () => {},
    recordDirtyChanged: () => {},
    uiZoomShortcut: () => {},
    beforeClose: () => {},
  })
  assert.doesNotThrow(unsubscribe)
})
