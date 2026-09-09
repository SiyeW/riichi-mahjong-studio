/// <reference types="vite/client" />

interface Window {
  studioAPI?: import('./contracts/desktopBridge').DesktopBridge
}

declare module '*.json' {
  const value: Record<string, string>
  export default value
}
