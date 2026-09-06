async function readLimitedResponseText(response, maxBytes, tooLargeMessage) {
  const tooLarge = () => new Error(tooLargeMessage)
  const advertisedBytes = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertisedBytes) && advertisedBytes > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw tooLarge()
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

module.exports = { readLimitedResponseText }
