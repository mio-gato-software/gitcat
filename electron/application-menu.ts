import type { app, Menu, MenuItemConstructorOptions } from "electron";
import { join } from "node:path";

/** Keep About information in the main process, using the installed app's metadata. */
export function installApplicationMenu(
  application: Pick<typeof app, "getVersion" | "getAppPath" | "setAboutPanelOptions">,
  menu: Pick<typeof Menu, "buildFromTemplate" | "setApplicationMenu">,
  runtime: Pick<NodeJS.Process, "platform" | "arch" | "versions">
) {
  const platformNames: Partial<Record<NodeJS.Platform, string>> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
  const platform = platformNames[runtime.platform] ?? runtime.platform;
  application.setAboutPanelOptions({
    applicationName: "GitCat",
    applicationVersion: application.getVersion(),
    copyright: "Copyright © 2026 Eliaquín Encarnación · MIT License",
    credits: [
      "A focused, AI-assisted Git workspace.",
      `${platform} (${runtime.arch})`,
      `Electron ${runtime.versions.electron} · Chromium ${runtime.versions.chrome} · Node.js ${runtime.versions.node}`,
      "https://github.com/mio-gato-software/gitcat"
    ].join("\n"),
    website: "https://github.com/mio-gato-software/gitcat",
    iconPath: join(application.getAppPath(), "build", "icon.png")
  });
  const template: MenuItemConstructorOptions[] = [
    runtime.platform === "darwin" ? { role: "appMenu", label: "GitCat" } : { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", label: "&Help", submenu: [{ role: "about", label: "About GitCat" }] }
  ];
  menu.setApplicationMenu(menu.buildFromTemplate(template));
}
