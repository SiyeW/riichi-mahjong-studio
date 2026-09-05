const fs = require('node:fs')
const { randomUUID } = require('node:crypto')

function writeFileAtomically(targetPath, contents, io = fs) {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`
  const descriptor = io.openSync(temporaryPath, 'wx')
  let open = true
  try {
    io.writeFileSync(descriptor, contents)
    io.fsyncSync(descriptor)
    io.closeSync(descriptor)
    open = false
    io.renameSync(temporaryPath, targetPath)
  } finally {
    if (open) io.closeSync(descriptor)
    if (io.existsSync(temporaryPath)) io.rmSync(temporaryPath, { force: true })
  }
}

module.exports = { writeFileAtomically }
