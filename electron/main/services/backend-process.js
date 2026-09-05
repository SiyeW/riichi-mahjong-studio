const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')

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
  let serviceReady = false
  let nextRequestId = 1
  const pendingRequests = new Map()
  const queuedRequests = new Map()
  let onUnsolicitedEvent = null

  function isDebugLine(line) {
    try {
      const payload = JSON.parse(line)
      if (payload && typeof payload === 'object' && 'request_id' in payload) {
        return false
      }
    } catch {
      return true
    }
    return true
  }

  function rejectPendingRequests(error) {
    pendingRequests.forEach(({ reject }) => reject(error))
    pendingRequests.clear()
    queuedRequests.clear()
  }

  function dispatchRequest(requestId, message, timeoutMs) {
    const pending = pendingRequests.get(requestId)
    if (!child || !pending) return
    clearTimeout(pending.startupTimer)
    pending.responseTimer = setTimeout(() => {
      pendingRequests.delete(requestId)
      pending.reject(new Error(`${name} request timed out: ${pending.command}`))
    }, timeoutMs)
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
      onUnsolicitedEvent?.({ type: 'service_stopped', error: message })
      return
    }
    child = spawnedChild
    let processStdoutBuffer = ''
    const stdoutDecoder = new StringDecoder('utf8')

    spawnedChild.on('error', (err) => {
      if (child !== spawnedChild) return
      console.error(`[${name}] spawn error: ${err.message}`)
      rejectPendingRequests(new Error(formatStartError(name, err.message)))
      child = null
      serviceReady = false
      onUnsolicitedEvent?.({ type: 'service_stopped', error: formatStartError(name, err.message) })
    })

    spawnedChild.stdin.on('error', (error) => {
      if (child !== spawnedChild) return
      rejectPendingRequests(error)
      child = null
      serviceReady = false
      spawnedChild.kill()
      onUnsolicitedEvent?.({ type: 'service_stopped', error: error.message })
    })

    spawnedChild.stdout.on('data', (chunk) => {
      if (child !== spawnedChild) return
      const text = stdoutDecoder.write(chunk)
      processStdoutBuffer += text

      let newlineIndex = processStdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0 && child === spawnedChild) {
        const line = processStdoutBuffer.slice(0, newlineIndex).trim()
        processStdoutBuffer = processStdoutBuffer.slice(newlineIndex + 1)

        if (line) {
          if (isDebugLine(line)) {
            process.stdout.write(`[${name}] ${line}\n`)
          }
          handleOutputLine(line)
        }

        newlineIndex = processStdoutBuffer.indexOf('\n')
      }
    })

    spawnedChild.stderr.on('data', (chunk) => {
      if (child !== spawnedChild) return
      process.stderr.write(`[${name}:error] ${chunk}`)
    })

    spawnedChild.on('exit', (code) => {
      if (child !== spawnedChild) return
      console.log(`[${name}] exited with code ${code}`)
      rejectPendingRequests(new Error(`${name} exited before responding.`))
      child = null
      serviceReady = false
      onUnsolicitedEvent?.({ type: 'service_stopped', error: `${name} exited with code ${code}` })
    })
  }

  function handleOutputLine(line) {
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      // The backend may also print diagnostic lines.
      return
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

  function stop() {
    if (!child) {
      return
    }
    rejectPendingRequests(new Error(`${name} stopped before responding.`))
    const stoppedChild = child
    child = null
    serviceReady = false
    stoppedChild.kill()
    onUnsolicitedEvent?.({ type: 'service_stopped' })
  }

  function restart() {
    stop()
    start()
  }

  function sendRequest(command, payload = {}, timeoutMs = 15_000) {
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
  }
}

module.exports = { createBackendProcess }
