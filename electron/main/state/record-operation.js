async function withCurrentRecord(fileStore, operation) {
  const generation = fileStore.getRecordGeneration()
  const result = await operation()
  if (generation !== fileStore.getRecordGeneration()) {
    throw new Error('The current record changed before the file operation completed.')
  }
  return result
}

module.exports = { withCurrentRecord }
