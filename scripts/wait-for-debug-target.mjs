import http from 'node:http'
import process from 'node:process'

const port = Number(process.argv[2] || 9222)
const expectedUrl = String(process.argv[3] || '')
const deadline = Date.now() + 30_000

function readTargets() {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/json/list', timeout: 1000 },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve([])
          }
        })
      },
    )
    request.on('error', () => resolve([]))
    request.on('timeout', () => {
      request.destroy()
      resolve([])
    })
  })
}

while (Date.now() < deadline) {
  const targets = await readTargets()
  const ready = Array.isArray(targets) && targets.some((target) => (
    target?.type === 'page'
    && (!expectedUrl || String(target.url || '').startsWith(expectedUrl))
  ))
  if (ready) process.exit(0)
  await new Promise((resolve) => setTimeout(resolve, 200))
}

console.error(`Timed out waiting for the renderer debug target on port ${port}`)
process.exit(1)
