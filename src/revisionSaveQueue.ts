// Serializes snapshots while edits may continue during an asynchronous save.
export function createRevisionSaveQueue<T>(
  snapshot: () => T,
  save: (value: T, revision: number) => Promise<boolean>,
) {
  let revision = 0
  let savedRevision = 0
  let request: Promise<boolean> | null = null

  function acknowledge(value: number) {
    savedRevision = Math.max(savedRevision, Math.min(value, revision))
  }

  async function flush(): Promise<boolean> {
    while (savedRevision < revision) {
      if (request) {
        if (!await request) return false
        continue
      }
      const savingRevision = revision
      const value = snapshot()
      // Defer execution until the shared request is installed, including sync failures.
      const saving = Promise.resolve().then(() => save(value, savingRevision))
        .then(success => {
          if (success) acknowledge(savingRevision)
          return success
        })
        .finally(() => { if (request === saving) request = null })
      request = saving
      if (!await saving) return false
    }
    return true
  }

  return {
    get revision() { return revision },
    get pending() { return savedRevision < revision },
    get saving() { return request !== null },
    changed() { revision += 1 },
    acknowledge,
    flush,
  }
}
