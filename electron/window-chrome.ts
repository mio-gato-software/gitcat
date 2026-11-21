import type { BrowserWindow } from "electron";

/** The native macOS window controls need space only in windowed mode. */
export function syncMacFullscreen(window: BrowserWindow) {
  if (process.platform !== "darwin") return;
  const sync = () => window.webContents.send("window:fullscreen", window.isFullScreen());
  window.on("enter-full-screen", sync);
  window.on("leave-full-screen", sync);
  window.webContents.on("dom-ready", sync);
}
