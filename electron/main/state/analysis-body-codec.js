// Eager diagnostic decoder only. Interactive codec execution belongs to Python.
const RESULT_LIMIT = 32 * 1024 * 1024
const MAX_ITEMS = 2_000_000
const decodeText = (data) => new TextDecoder('utf-8', { fatal: true }).decode(data)
const validatedSchemas = new WeakMap()

function validateAnalysisSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid analysis schema.')
  if (validatedSchemas.has(schema)) return validatedSchemas.get(schema)
  let nodes = 0, probabilities = 0
  function visit(tree, depth = 0) {
    nodes += 1
    if (nodes > MAX_ITEMS || depth > 96 || !Array.isArray(tree)) throw new Error('Invalid analysis schema.')
    if (tree[0] === 'o' && tree.length === 2 && Array.isArray(tree[1])) {
      const keys = new Set()
      for (const pair of tree[1]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || keys.has(pair[0])) throw new Error('Invalid object schema.')
        keys.add(pair[0]); visit(pair[1], depth + 1)
      }
    } else if (tree[0] === 'a' && tree.length === 2 && Array.isArray(tree[1])) {
      for (const child of tree[1]) visit(child, depth + 1)
    } else if (tree[0] === 'c' && tree.length === 2 && (tree[1] === null || typeof tree[1] !== 'object')) {
      if (typeof tree[1] === 'number' && !Number.isFinite(tree[1])) throw new Error('Invalid schema constant.')
    } else if (tree[0] === 'p' && tree.length === 1) {
      probabilities += 1
    } else if (tree[0] === 'f' && tree.length === 1) {
      // Exact IEEE scalar.
    } else if (tree[0] === 'n' && tree.length === 2 && [1, 1000].includes(tree[1])) {
      // Scaled scalar with an exact escape.
    } else if (tree[0] !== 'j' || tree.length !== 1) {
      throw new Error('Invalid analysis schema node.')
    }
  }
  visit(schema.tree)
  if (schema.projection !== undefined && schema.projection !== null
      && (!Number.isInteger(schema.projection) || schema.projection < 0 || schema.projection >= 4)) throw new Error('Invalid projection seat.')
  validatedSchemas.set(schema, probabilities)
  return probabilities
}

class Cursor {
  constructor(data) { this.data = data; this.offset = 0 }
  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.data.length - this.offset) {
      throw new Error('Incomplete record binary stream.')
    }
    const value = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
  u64() {
    const value = Number(this.take(8).readBigUInt64LE())
    if (!Number.isSafeInteger(value)) throw new Error('Invalid record size.')
    return value
  }
  unsigned() {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.take(1)[0]
      value |= BigInt(byte & 127) << shift
      if (byte < 128) {
        if (value >= (1n << 64n) || (shift && byte === 0)) break
        return value
      }
    }
    throw new Error('Invalid record varint.')
  }
  finish() {
    if (this.offset !== this.data.length) throw new Error('Trailing record binary stream data.')
  }
}

function deriveProjection(outputs, seat) {
  const opponents = {}, waits = {}
  const shanten = outputs['opponent-shanten']?.players
  const risk = outputs['opponent-deal-in-probability']?.players
  const tiles = ['m', 'p', 's'].flatMap(suit => Array.from({ length: 9 }, (_, i) => `${i + 1}${suit}`))
    .concat(['E', 'S', 'W', 'N', 'P', 'F', 'C'])
  // The existing Python legacy display projection uses ties-to-even; this is
  // separate from the JS rounding contract for newly stored point estimates.
  const roundEven = value => {
    const floor = Math.floor(value)
    return value - floor === .5 ? floor + (floor % 2) : Math.round(value)
  }
  const compact = (p) => p === 0 ? 0 : p < .0001 ? .00001 : roundEven(p * 10000) / 10000
  for (const [i, label] of ['shimocha', 'toimen', 'kamicha'].entries()) {
    const target = (seat + i + 1) % 4
    if (shanten) {
      const player = shanten.find(item => item.seat === target)
      if (!player || player.shanten?.length !== 7) throw new Error('Invalid projected shanten.')
      const values = Array.from({ length: 7 }, (_, value) => player.shanten.find(item => item.value === value)?.probability)
      if (values.some(p => !Number.isFinite(p)) || !Number.isFinite(player.furitenOrNoYaku)) throw new Error('Invalid projected shanten.')
      opponents[label] = [values[0] * (1 - player.furitenOrNoYaku), ...values.slice(1), values[0] * player.furitenOrNoYaku]
        .map(p => compact(Math.fround(p)))
    }
    if (risk) {
      const player = risk.find(item => item.seat === target)
      if (!player || tiles.some(tile => !Number.isFinite(player.tiles?.[tile]))) throw new Error('Invalid projected deal-in data.')
      waits[label] = tiles.map(tile => compact(player.tiles[tile]))
    }
  }
  return { opponents, ron_wait: waits }
}

function decodeAnalysisBody(data, schemas) {
  if (data.length > RESULT_LIMIT) throw new Error('Analysis body exceeds its size limit.')
  const input = new Cursor(data)
  const mode = input.take(1)[0]
  if (mode === 0) {
    const value = JSON.parse(decodeText(input.take(input.u64())))
    input.finish()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid analysis result.')
    return value
  }
  if (mode !== 1) throw new Error('Unknown analysis body mode.')
  const id = input.take(4).readUInt32LE(), count = input.take(4).readUInt32LE()
  const coordinateLength = input.u64(), scalarLength = input.u64(), opaqueLength = input.u64()
  if (!schemas[id] || count > validateAnalysisSchema(schemas[id])) throw new Error('Invalid analysis schema/count.')
  const coordinates = new Cursor(input.take(coordinateLength))
  const packed = input.take(Math.ceil(count * 20 / 8))
  const codes = []
  let bits = 0, available = 0, position = 0, escapeLength = 0
  for (let i = 0; i < count; i += 1) {
    while (available < 20) {
      bits += packed[position++] * (2 ** available)
      available += 8
    }
    const code = bits % (2 ** 20)
    codes.push(code)
    bits = Math.floor(bits / (2 ** 20))
    available -= 20
    escapeLength += code === 0xffffe ? 4 : code === 0xfffff ? 8 : 0
  }
  if (bits) throw new Error('Nonzero probability padding.')
  const escapes = new Cursor(input.take(escapeLength))
  const scalars = new Cursor(input.take(scalarLength)), opaque = new Cursor(input.take(opaqueLength))
  input.finish()
  const probabilities = new Map()
  let index = -1
  for (const code of codes) {
    index += Number(coordinates.unsigned()) + 1
    if (!Number.isSafeInteger(index) || index >= MAX_ITEMS || code === 0) throw new Error('Invalid probability coordinate.')
    let value
    if (code === 0xffffe) value = escapes.take(4).readFloatLE()
    else if (code === 0xfffff) value = escapes.take(8).readDoubleLE()
    else {
      const word = Buffer.alloc(4)
      word.writeUInt32LE(Math.floor(code / 2) * 2048)
      const inner = word.readFloatLE()
      value = code & 1 ? 1 - inner : inner
    }
    if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error('Invalid compact probability.')
    probabilities.set(index, value)
  }
  coordinates.finish(); escapes.finish()
  let probabilityIndex = 0, nodes = 0
  function restore(tree, depth = 0) {
    nodes += 1
    if (nodes > MAX_ITEMS || depth > 96 || !Array.isArray(tree)) throw new Error('Invalid analysis schema.')
    switch (tree[0]) {
      case 'o': {
        if (tree.length !== 2 || !Array.isArray(tree[1])) break
        const keys = new Set()
        return Object.fromEntries(tree[1].map(pair => {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || keys.has(pair[0])) throw new Error('Invalid object schema.')
          keys.add(pair[0])
          return [pair[0], restore(pair[1], depth + 1)]
        }))
      }
      case 'a':
        if (tree.length === 2 && Array.isArray(tree[1])) return tree[1].map(child => restore(child, depth + 1))
        break
      case 'c':
        if (tree.length === 2 && (tree[1] === null || typeof tree[1] !== 'object')) return tree[1]
        break
      case 'p':
        if (tree.length === 1) return probabilities.get(probabilityIndex++) ?? 0
        break
      case 'n': {
        if (tree.length !== 2 || ![1, 1000].includes(tree[1])) break
        const token = scalars.unsigned()
        const zigzag = token - 1n
        const value = token === 0n ? scalars.take(8).readDoubleLE()
          : Number((zigzag >> 1n) ^ -(zigzag & 1n)) / tree[1]
        if (!Number.isFinite(value)) throw new Error('Invalid analysis scalar.')
        return value
      }
      case 'f': {
        if (tree.length !== 1) break
        const value = scalars.take(8).readDoubleLE()
        if (!Number.isFinite(value)) throw new Error('Invalid analysis scalar.')
        return value
      }
      case 'j':
        if (tree.length === 1) return JSON.parse(decodeText(opaque.take(opaque.u64())))
        break
    }
    throw new Error('Invalid analysis schema node.')
  }
  const result = restore(schemas[id].tree)
  if (index >= probabilityIndex) throw new Error('Probability coordinate exceeds its schema.')
  scalars.finish(); opaque.finish()
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid analysis result.')
  if (schemas[id].projection !== null && schemas[id].projection !== undefined) {
    const seat = schemas[id].projection
    if (!Number.isInteger(seat) || seat < 0 || seat >= 4) throw new Error('Invalid projection seat.')
    result.predictions = deriveProjection(result.outputs, seat)
  }
  return result
}

module.exports = { decodeAnalysisBody, validateAnalysisSchema }
