const ANALYSIS_CACHE_STORAGE_FIELD = 'analysisCacheStorage'
const ANALYSIS_CACHE_STORAGE_VERSION = 1
const ANALYSIS_CACHE_CODEC = 'binary-json-f64-v1'

const TAG = Object.freeze({
  NULL: 0,
  FALSE: 1,
  TRUE: 2,
  NUMBER: 3,
  STRING: 4,
  ARRAY: 5,
  OBJECT: 6,
})

function encodeFloat64(values) {
  const buffer = Buffer.allocUnsafe(values.length * 8)
  values.forEach((value, index) => buffer.writeDoubleLE(value, index * 8))
  return buffer.toString('base64')
}

function decodeFloat64(encoded) {
  const buffer = Buffer.from(String(encoded || ''), 'base64')
  if (buffer.length % 8 !== 0) throw new Error('Invalid packed analysis number data.')
  return Array.from({ length: buffer.length / 8 }, (_, index) => buffer.readDoubleLE(index * 8))
}

function encodeBitmap(bits) {
  const buffer = Buffer.alloc(Math.ceil(bits.length / 8))
  bits.forEach((value, index) => {
    if (value) buffer[index >> 3] |= 1 << (index & 7)
  })
  return buffer.toString('base64')
}

function decodeBitmap(encoded, length) {
  const buffer = Buffer.from(String(encoded || ''), 'base64')
  if (buffer.length !== Math.ceil(length / 8)) throw new Error('Invalid packed analysis bitmap.')
  return Array.from({ length }, (_, index) => Boolean(buffer[index >> 3] & (1 << (index & 7))))
}

function packJson(value) {
  const strings = []
  const stringIndexes = new Map()
  const tokens = []
  const numbers = []
  const numberZeroBits = []

  function stringIndex(value) {
    let index = stringIndexes.get(value)
    if (index !== undefined) return index
    index = strings.length
    strings.push(value)
    stringIndexes.set(value, index)
    return index
  }

  function variableUnsigned(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid packed analysis index.')
    do {
      const byte = value % 128
      value = Math.floor(value / 128)
      tokens.push(byte | (value ? 0x80 : 0))
    } while (value)
  }

  function token(tag, payload) {
    tokens.push(tag)
    if (payload !== undefined) variableUnsigned(payload)
  }

  function visit(current) {
    if (current === null) return token(TAG.NULL)
    if (current === false) return token(TAG.FALSE)
    if (current === true) return token(TAG.TRUE)
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('Analysis cache contains a non-finite number.')
      token(TAG.NUMBER)
      const isZero = current === 0
      numberZeroBits.push(isZero)
      if (!isZero) numbers.push(current)
      return
    }
    if (typeof current === 'string') return token(TAG.STRING, stringIndex(current))
    if (Array.isArray(current)) {
      token(TAG.ARRAY, current.length)
      current.forEach(visit)
      return
    }
    if (current && typeof current === 'object') {
      const entries = Object.entries(current)
      token(TAG.OBJECT, entries.length)
      for (const [key, child] of entries) {
        variableUnsigned(stringIndex(key))
        visit(child)
      }
      return
    }
    throw new Error(`Unsupported analysis cache value: ${typeof current}`)
  }

  visit(value)
  return {
    strings,
    tokens: Buffer.from(tokens).toString('base64'),
    numbers: encodeFloat64(numbers),
    numberCount: numberZeroBits.length,
    exactZero: encodeBitmap(numberZeroBits),
  }
}

function unpackJson(packed) {
  if (!packed || !Array.isArray(packed.strings)) throw new Error('Invalid packed analysis payload.')
  const tokens = Buffer.from(String(packed.tokens || ''), 'base64')
  const numbers = decodeFloat64(packed.numbers)
  const numberCount = Number(packed.numberCount)
  if (!Number.isSafeInteger(numberCount) || numberCount < 0) throw new Error('Invalid packed analysis number count.')
  const zeroBits = decodeBitmap(packed.exactZero, numberCount)
  let tokenIndex = 0
  let numberIndex = 0
  let numberOrdinal = 0

  function variableUnsigned() {
    let value = 0
    let multiplier = 1
    for (let count = 0; count < 8; count += 1) {
      if (tokenIndex >= tokens.length) throw new Error('Packed analysis index ended unexpectedly.')
      const byte = tokens[tokenIndex++]
      value += (byte & 0x7f) * multiplier
      if (!(byte & 0x80)) return value
      multiplier *= 128
    }
    throw new Error('Packed analysis index is too large.')
  }

  function read() {
    if (tokenIndex >= tokens.length) throw new Error('Packed analysis payload ended unexpectedly.')
    const tag = tokens[tokenIndex++]
    if (tag === TAG.NULL) return null
    if (tag === TAG.FALSE) return false
    if (tag === TAG.TRUE) return true
    if (tag === TAG.NUMBER) {
      if (numberOrdinal >= zeroBits.length) throw new Error('Packed analysis number bitmap ended unexpectedly.')
      const value = zeroBits[numberOrdinal++] ? 0 : numbers[numberIndex++]
      if (value === undefined) throw new Error('Packed analysis number data ended unexpectedly.')
      return value
    }
    if (tag === TAG.STRING) {
      const payload = variableUnsigned()
      if (payload >= packed.strings.length) throw new Error('Packed analysis string index is out of range.')
      return packed.strings[payload]
    }
    if (tag === TAG.ARRAY) return Array.from({ length: variableUnsigned() }, read)
    if (tag === TAG.OBJECT) {
      const value = {}
      const length = variableUnsigned()
      for (let index = 0; index < length; index += 1) {
        const keyIndex = variableUnsigned()
        if (keyIndex >= packed.strings.length) throw new Error('Packed analysis key index is out of range.')
        value[packed.strings[keyIndex]] = read()
      }
      return value
    }
    throw new Error(`Unknown packed analysis tag: ${tag}`)
  }

  const value = read()
  if (tokenIndex !== tokens.length || numberOrdinal !== numberCount || numberIndex !== numbers.length) {
    throw new Error('Packed analysis payload contains trailing data.')
  }
  return value
}

function compactAnalysisCaches(record) {
  const nodes = record?.game?.nodes
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return record
  const nodeEntries = Object.entries(nodes)
  const decisionPresence = []
  const opponentPresence = []
  const decisionValues = []
  const opponentValues = []
  let changed = false
  const compactNodes = {}

  for (const [nodeId, node] of nodeEntries) {
    const decisionPresent = Boolean(node && Object.hasOwn(node, 'analysisCache'))
    const opponentPresent = Boolean(node && Object.hasOwn(node, 'opponentAnalysisCache'))
    decisionPresence.push(decisionPresent)
    opponentPresence.push(opponentPresent)
    if (decisionPresent) decisionValues.push(node.analysisCache)
    if (opponentPresent) opponentValues.push(node.opponentAnalysisCache)
    if (decisionPresent || opponentPresent) {
      changed = true
      const compactNode = { ...node }
      delete compactNode.analysisCache
      delete compactNode.opponentAnalysisCache
      compactNodes[nodeId] = compactNode
    } else {
      compactNodes[nodeId] = node
    }
  }
  if (!changed) return record

  return {
    ...record,
    game: { ...record.game, nodes: compactNodes },
    [ANALYSIS_CACHE_STORAGE_FIELD]: {
      schemaVersion: ANALYSIS_CACHE_STORAGE_VERSION,
      codec: ANALYSIS_CACHE_CODEC,
      nodeIds: nodeEntries.map(([nodeId]) => nodeId),
      decision: {
        presence: encodeBitmap(decisionPresence),
        values: packJson(decisionValues),
      },
      opponent: {
        presence: encodeBitmap(opponentPresence),
        values: packJson(opponentValues),
      },
    },
  }
}

function expandAnalysisCaches(record) {
  const storage = record?.[ANALYSIS_CACHE_STORAGE_FIELD]
  if (storage === undefined) return record
  if (storage?.schemaVersion !== ANALYSIS_CACHE_STORAGE_VERSION || storage?.codec !== ANALYSIS_CACHE_CODEC) {
    throw new Error('Unsupported analysis cache storage format.')
  }
  const nodes = record?.game?.nodes
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes) || !Array.isArray(storage.nodeIds)) {
    throw new Error('Packed analysis cache does not match a record tree.')
  }
  const currentNodeIds = Object.keys(nodes)
  if (storage.nodeIds.length !== currentNodeIds.length
    || storage.nodeIds.some((nodeId, index) => nodeId !== currentNodeIds[index])) {
    throw new Error('Packed analysis cache node order does not match the record tree.')
  }
  const decisionPresence = decodeBitmap(storage.decision?.presence, currentNodeIds.length)
  const opponentPresence = decodeBitmap(storage.opponent?.presence, currentNodeIds.length)
  const decisionValues = unpackJson(storage.decision?.values)
  const opponentValues = unpackJson(storage.opponent?.values)
  if (!Array.isArray(decisionValues) || !Array.isArray(opponentValues)
    || decisionValues.length !== decisionPresence.filter(Boolean).length
    || opponentValues.length !== opponentPresence.filter(Boolean).length) {
    throw new Error('Packed analysis cache value count does not match its presence bitmap.')
  }

  let decisionIndex = 0
  let opponentIndex = 0
  const expandedNodes = Object.fromEntries(currentNodeIds.map((nodeId, index) => {
    const node = { ...nodes[nodeId] }
    if (decisionPresence[index]) node.analysisCache = decisionValues[decisionIndex++]
    if (opponentPresence[index]) node.opponentAnalysisCache = opponentValues[opponentIndex++]
    return [nodeId, node]
  }))
  const expanded = { ...record, game: { ...record.game, nodes: expandedNodes } }
  delete expanded[ANALYSIS_CACHE_STORAGE_FIELD]
  return expanded
}

module.exports = {
  ANALYSIS_CACHE_CODEC,
  ANALYSIS_CACHE_STORAGE_FIELD,
  ANALYSIS_CACHE_STORAGE_VERSION,
  compactAnalysisCaches,
  expandAnalysisCaches,
  packJson,
  unpackJson,
}
