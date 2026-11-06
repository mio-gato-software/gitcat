import type { app, BrowserWindow } from "electron";

type AppWindow = Pick<BrowserWindow, "isMinimized" | "restore" | "show" | "focus">;

/** A second Windows shortcut launch must not start another writer on the same profile. */
export function keepSingleInstance(
  application: Pick<typeof app, "requestSingleInstanceLock" | "quit" | "on">,
  getWindow: () => AppWindow | null
) {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }
  application.on("second-instance", () => {
    const window = getWindow();
    if (!window) return; // The first window is still starting up.
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
