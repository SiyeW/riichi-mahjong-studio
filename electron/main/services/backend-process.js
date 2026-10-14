const { spawn } = require('node:child_process')

function stringifyProtocolMessage(payload) {
  return JSON.stringify(payload).replace(/[\u0080-\uFFFF]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ))
}

function createBackendProcess({
  name,
  pythonExecutable,
  scriptPath,
  args = [],
  cwd,
  env = {},
  spawnProcess = spawn,
  formatStartError = (processName, message) => `${processName} failed to start: ${message}`,
}) {
  let child = null
  let stopping = null
  let restarting = null
  let serviceReady = false
  let nextRequestId = 1
  const pendingRequests = new Map()
  const queuedRequests = new Map()
  let onUnsolicitedEvent = null

  function notifyStopped(error) {
    try {
      onUnsolicitedEvent?.({ type: 'service_stopped', ...(error ? { error } : {}) })
    } catch (callbackError) {
      console.error(`[${name}] output handler failed:`, callbackError)
    }
  }

  function rejectPendingRequests(error) {
    pendingRequests.forEach(({ reject }) => reject(error))
    pendingRequests.clear()
    queuedRequests.clear()
  }

  function dispatchRequest(requestId, message, timeoutMs) {
    const pending = pendingRequests.get(requestId)
    if (!child || stopping || !pending) return
    clearTimeout(pending.startupTimer)
    // null means an owned operation: keep tracking until a definitive reply or
    // process failure. A timeout cannot cancel a state-changing file operation.
    if (timeoutMs !== null) {
      pending.responseTimer = setTimeout(() => {
        pendingRequests.delete(requestId)
        pending.reject(new Error(`${name} request timed out: ${pending.command}`))
      }, timeoutMs)
    }
    const target = child
    const failWrite = (error) => {
      if (!error || child !== target || pendingRequests.get(requestId) !== pending) return
      pendingRequests.delete(requestId)
      pending.reject(error)
    }
    try {
      target.stdin.write(`${message}\n`, failWrite)
    } catch (error) {
      failWrite(error)
    }
  }

  function flushQueuedRequests() {
    const requests = [...queuedRequests.values()]
    queuedRequests.clear()
    requests.forEach(({ requestId, message, timeoutMs }) => {
      dispatchRequest(requestId, message, timeoutMs)
    })
  }

  function start() {
    if (child) {
      return
    }

    serviceReady = false

    const spawnArgs = scriptPath ? [scriptPath, ...args] : [...args]

    let spawnedChild
    try {
      spawnedChild = spawnProcess(pythonExecutable, spawnArgs, {
      cwd,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      const message = formatStartError(name, error instanceof Error ? error.message : String(error))
      rejectPendingRequests(new Error(message))
      notifyStopped(message)
      return
    }
    child = spawnedChild
    function exited(error) {
      if (child !== spawnedChild) return
      const operation = stopping
      rejectPendingRequests(new Error(error || `${name} exited before responding.`))
      child = null
      serviceReady = false
      stopping = null
      if (!operation) notifyStopped(error)
      operation?.resolve()
    }
    let lineChunks = []
    let lineBytes = 0

    spawnedChild.on('error', (err) => {
      if (child !== spawnedChild) return
      console.error(`[${name}] spawn error: ${err.message}`)
      const message = formatStartError(name, err.message)
      if (!spawnedChild.pid) exited(message) // Failed spawn has no live process.
      else stop(message)
    })

    spawnedChild.stdin.on('error', (error) => {
      if (child !== spawnedChild) return
      stop(error.message)
    })

    spawnedChild.stdout.on('data', (chunk) => {
      if (child !== spawnedChild || stopping) return
      // Search each byte once. Joining a growing string and rescanning it for
      // every chunk makes multi-megabyte record responses quadratic.
      let offset = 0
      while (offset < chunk.length && child === spawnedChild && !stopping) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        const part = chunk.subarray(offset, end)
        lineChunks.push(part)
        lineBytes += part.length
        if (newline < 0) break
        const line = Buffer.concat(lineChunks, lineBytes).toString('utf8').trim()
        lineChunks = []
        lineBytes = 0
        if (line) handleOutputLine(line)
        offset = newline + 1
      }
    })

    spawnedChild.stderr.on('data', (chunk) => {
      if (child !== spawnedChild) return
      process.stderr.write(`[${name}:error] ${chunk}`)
    })

    spawnedChild.on('exit', (code) => {
      if (child !== spawnedChild) return
      console.log(`[${name}] exited with code ${code}`)
      exited()
    })
  }

  function handleOutputLine(line) {
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      // The backend may also print diagnostic lines.
      process.stdout.write(`[${name}] ${line}\n`)
      return
    }
    if (!payload || typeof payload !== 'object' || !('request_id' in payload)) {
      process.stdout.write(`[${name}] ${line}\n`)
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    try {
      const requestId = payload?.request_id
      if (!requestId && payload?.type === 'service_ready') {
        serviceReady = true
        flushQueuedRequests()
      }
      if (!requestId || !pendingRequests.has(requestId)) {
        if (onUnsolicitedEvent && payload.type && !requestId) {
          onUnsolicitedEvent(payload)
        }
        return
      }

      const { resolve, reject } = pendingRequests.get(requestId)
      pendingRequests.delete(requestId)

      if (payload.error) {
        reject(new Error(String(payload.error)))
        return
      }

      resolve(payload)
    } catch (error) {
      console.error(`[${name}] output handler failed:`, error)
    }
  }

  function stop(error) {
    if (stopping) return stopping.promise
    if (!child) return Promise.resolve()
    rejectPendingRequests(new Error(error || `${name} stopped before responding.`))
    const stoppedChild = child
    let resolve
    const promise = new Promise(done => { resolve = done })
    stopping = { child: stoppedChild, promise, resolve }
    serviceReady = false
    notifyStopped(error)
    // kill() requests termination; it does not release this process's ownership.
    // Keep the child until its exit event, including a false kill() return.
    try { stoppedChild.kill() } catch (killError) {
      console.error(`[${name}] termination request failed:`, killError)
    }
    return promise
  }

  function restart() {
    if (restarting) return restarting
    restarting = stop().then(() => { start() }).finally(() => { restarting = null })
    return restarting
  }

  function sendRequest(command, payload = {}, timeoutMs = 15_000) {
    if (stopping) return Promise.reject(new Error(`${name} is waiting for its previous process to exit.`))
    start()

    if (!child) {
      return Promise.reject(new Error(`${name} service is not running.`))
    }

    const requestId = `${name}_${nextRequestId++}`
    const message = stringifyProtocolMessage({
      request_id: requestId,
      command,
      payload,
    })

    return new Promise((resolve, reject) => {
      const pending = {
        command,
        responseTimer: null,
        startupTimer: null,
        resolve: (response) => {
          clearTimeout(pending.responseTimer)
          clearTimeout(pending.startupTimer)
          resolve(response)
        },
        reject: (error) => {
          clearTimeout(pending.responseTimer)
          clearTimeout(pending.startupTimer)
          reject(error)
        },
      }
      pending.startupTimer = setTimeout(() => {
        pendingRequests.delete(requestId)
        queuedRequests.delete(requestId)
        pending.reject(new Error(`${name} did not become ready within 60 seconds.`))
      }, 60_000)
      pendingRequests.set(requestId, pending)

      if (serviceReady) {
        dispatchRequest(requestId, message, timeoutMs)
      } else {
        queuedRequests.set(requestId, { requestId, message, timeoutMs })
      }
    })
  }

  return {
    name,
    start,
    stop,
    restart,
    sendRequest,
    onEvent(callback) {
      onUnsolicitedEvent = callback
    },
    isRunning() {
      return Boolean(child)
    },
    isStopping() {
      return Boolean(stopping)
    },
  }
}

module.exports = { createBackendProcess }
