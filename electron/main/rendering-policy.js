function configurePageRasterization(app, platform = process.platform) {
  if (platform !== 'win32') return
  const commandLine = app.commandLine
  if (commandLine.hasSwitch('enable-gpu-rasterization')
    || commandLine.hasSwitch('disable-gpu-rasterization')) return

  // Windows foreground traces show long GPU raster batches for the tile-heavy
  // DOM. CPU page rasterization avoids them without disabling GPU composition,
  // accelerated canvases, or external model inference. Keep explicit A/B flags.
  commandLine.appendSwitch('disable-gpu-rasterization')
}

module.exports = { configurePageRasterization }
