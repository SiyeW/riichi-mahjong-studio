const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { writeFileAtomically } = require('./atomic-file')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-atomic-write-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'record.json')
  fs.writeFileSync(target, 'original')
  return { directory, target }
}

test('atomic writes replace existing files and create new files without leftovers', (t) => {
  const { directory, target } = fixture(t)
  writeFileAtomically(target, '新しい記録🀄')
  assert.equal(fs.readFileSync(target, 'utf8'), '新しい記録🀄')
  const binary = path.join(directory, 'record.bin')
  writeFileAtomically(binary, Buffer.from([0, 255, 128]))
  assert.deepEqual(fs.readFileSync(binary), Buffer.from([0, 255, 128]))
  assert.deepEqual(fs.readdirSync(directory).sort(), ['record.bin', 'record.json'])
})

for (const stage of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`atomic writes preserve the old file when ${stage} fails`, (t) => {
    const { directory, target } = fixture(t)
    const failure = new Error(`simulated ${stage} failure`)
    const io = {
      ...fs,
      [stage](...args) {
        if (stage === 'writeFileSync') fs.writeFileSync(args[0], 'partial')
        throw failure
      },
    }
    assert.throws(() => writeFileAtomically(target, 'replacement', io), (error) => error === failure)
    assert.equal(fs.readFileSync(target, 'utf8'), 'original')
    assert.deepEqual(fs.readdirSync(directory), ['record.json'])
  })
}
