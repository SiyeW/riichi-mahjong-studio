export async function flushBeforeClose(
  saveComments: () => Promise<void>,
  saveEngines: () => Promise<boolean>,
  engineError: () => string,
  stopAnalysis: () => Promise<void> = async () => {},
): Promise<void> {
  // Settle pending edits and analysis cancellation before offering to exit anyway.
  const [comments, engines, analysis] = await Promise.allSettled([
    Promise.resolve().then(saveComments),
    Promise.resolve().then(saveEngines),
    Promise.resolve().then(stopAnalysis),
  ])
  if (comments.status === 'rejected') throw comments.reason
  if (engines.status === 'rejected') throw engines.reason
  if (!engines.value) throw new Error(engineError())
  if (analysis.status === 'rejected') throw analysis.reason
}
