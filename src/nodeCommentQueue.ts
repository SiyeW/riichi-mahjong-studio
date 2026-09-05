export type NodeCommentUpdate = { key: string; nodeId: string; comment: string }

export function nodeCommentKey(gameId: string | null | undefined, nodeId: string | null | undefined) {
  return gameId && nodeId ? `${gameId}\u0000${nodeId}` : ''
}

export function createNodeCommentQueue(
  save: (update: NodeCommentUpdate) => Promise<{ comment: string }>,
  onSaved: (update: NodeCommentUpdate, comment: string) => void = () => {},
) {
  const drafts = new Map<string, NodeCommentUpdate>()
  const pending = new Map<string, NodeCommentUpdate>()
  let queue: Promise<void> = Promise.resolve()

  function set(key: string, nodeId: string, comment: string) {
    // Identity distinguishes separate edits, including A -> B -> A.
    const update = { key, nodeId, comment }
    drafts.set(key, update)
    pending.set(key, update)
  }

  function discard(key: string) {
    drafts.delete(key)
    pending.delete(key)
  }

  function clear() {
    drafts.clear()
    pending.clear()
  }

  function flush(): Promise<void> {
    queue = queue.catch(() => undefined).then(async () => {
      while (pending.size) {
        const update = pending.values().next().value!
        pending.delete(update.key)
        let response: { comment: string }
        try {
          response = await save(update)
        } catch (error) {
          // Keep newer edits intact; discarded drafts must not reappear on failure.
          if (drafts.get(update.key) === update) pending.set(update.key, update)
          throw error
        }
        if (drafts.get(update.key) === update) {
          drafts.delete(update.key)
          onSaved(update, response.comment)
        }
      }
    })
    return queue
  }

  return { set, discard, clear, flush, hasDrafts: () => drafts.size > 0,
    get: (key: string) => drafts.get(key)?.comment }
}
