// URLs remain the canonical native <img> source. Raw text is loaded only for an
// explicitly enabled transient motion snapshot, including packaged file:// use.
const assets = import.meta.glob('../assets/tiles/Regular_shortnames/*.svg', {
  eager: true, import: 'default',
}) as Record<string, string>
const raw = import.meta.glob('../assets/tiles/Regular_shortnames/*.svg', {
  query: '?raw', import: 'default',
}) as Record<string, () => Promise<string>>

export const tileArtworkByName = Object.fromEntries(Object.entries(assets)
  .map(([name, source]) => [name.slice(name.lastIndexOf('/') + 1, -4), source]))
export const tileArtworkSources = [...new Set(Object.values(assets).filter(Boolean))]

export async function embeddedTileArtwork(source: string): Promise<string> {
  const name = Object.keys(assets).find(name => new URL(assets[name]!, document.baseURI).href === source)
  if (!name || !raw[name]) throw Error('Unknown tile artwork')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await raw[name]!())}`
}
