import { Buffer } from 'node:buffer'

export function parseRenderingTrace(source: string): Record<string, unknown>[] {
  const trace = JSON.parse(source, (_key, value, context?: { source?: string }) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || Number.isSafeInteger(value)) return value
    if (!context?.source) throw new Error('Lossless rendering trace parsing requires JSON source context.')
    return context.source
  })
  if (!trace || !Array.isArray(trace.traceEvents)) throw new Error('Rendering trace has no event array.')
  return trace.traceEvents
}

interface TraceChunk {
  data: string
  eof: boolean
  base64Encoded?: boolean
}

interface TraceStreamClient {
  send: (method: 'IO.read' | 'IO.close', params: { handle: string; size?: number }) => Promise<TraceChunk | undefined>
}

// Read the original JSON after sampling. ReportEvents has already rounded any
// uint64 identifiers before Node receives its parsed event batches.
export async function readRenderingTrace(client: TraceStreamClient, handle: string, maximumBytes = 128 * 1024 * 1024) {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await client.send('IO.read', { handle, size: 1024 * 1024 })
      if (!chunk || typeof chunk.data !== 'string') throw new Error('Rendering trace stream returned an invalid chunk.')
      const buffer = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8')
      bytes += buffer.byteLength
      if (bytes > maximumBytes) throw new Error('Rendering trace exceeded its capture byte limit.')
      chunks.push(buffer)
      if (chunk.eof) return parseRenderingTrace(Buffer.concat(chunks).toString('utf8'))
    }
  } finally {
    await client.send('IO.close', { handle })
  }
}
