async function createRecord(createGame, fileStore, beginTracking) {
  const response = await createGame()
  fileStore.prepareUnsavedRecord()
  beginTracking({ dirty: true })
  return response
}

module.exports = { createRecord }
