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

async function writeFileAtomicallyAsync(targetPath, contents, io = fs.promises) {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`
  let handle = null
  try {
    handle = await io.open(temporaryPath, 'wx')
    await handle.writeFile(contents)
    await handle.sync()
    await handle.close()
    handle = null
    await io.rename(temporaryPath, targetPath)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await io.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

module.exports = { writeFileAtomically, writeFileAtomicallyAsync }
