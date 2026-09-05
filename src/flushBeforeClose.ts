export async function flushBeforeClose(
  saveComments: () => Promise<void>,
  saveEngines: () => Promise<boolean>,
  engineError: () => string,
): Promise<void> {
  // Wait for both, even when one fails, before offering to exit anyway.
  const [comments, engines] = await Promise.allSettled([
    Promise.resolve().then(saveComments),
    Promise.resolve().then(saveEngines),
  ])
  if (comments.status === 'rejected') throw comments.reason
  if (engines.status === 'rejected') throw engines.reason
  if (!engines.value) throw new Error(engineError())
}
