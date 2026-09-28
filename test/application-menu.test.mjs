import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { installApplicationMenu } from "../dist-electron/electron/application-menu.js";

for (const [platform, name] of [["win32", "Windows"], ["darwin", "macOS"], ["linux", "Linux"]]) {
  test(`${name} exposes Help → About with the installed version and keeps native menus`, () => {
    let options;
    let installed;
    const builtMenu = {};
    const application = {
      getVersion: () => "2.3.4-preview.5",
      getAppPath: () => "/installed/gitcat",
      setAboutPanelOptions: (value) => { options = value; }
    };
    const menu = {
      buildFromTemplate: (template) => { installed = template; return builtMenu; },
      setApplicationMenu: (value) => { assert.equal(value, builtMenu); }
    };
    installApplicationMenu(application, menu, {
      platform, arch: "arm64", versions: { electron: "43.3.0", chrome: "150.0.0", node: "24.0.0" }
    });
    assert.equal(options.applicationName, "GitCat");
    assert.equal(options.applicationVersion, "2.3.4-preview.5", "use app metadata rather than a hard-coded release number");
    assert.ok(options.credits.includes(`${name} (arm64)`));
    assert.match(options.credits, /Electron 43\.3\.0.*Chromium 150\.0\.0.*Node\.js 24\.0\.0/);
    assert.match(options.copyright, /MIT License/);
    assert.match(options.credits, /https:\/\/github\.com\/mio-gato-software\/gitcat/);
    assert.equal(options.iconPath, join("/installed/gitcat", "build", "icon.png"));
    assert.deepEqual(installed.slice(0, 4).map((item) => item.role), [
      platform === "darwin" ? "appMenu" : "fileMenu", "editMenu", "viewMenu", "windowMenu"
    ]);
    const help = installed.find((item) => item.role === "help");
    assert.equal(help.label, platform === "darwin" ? "Help" : "&Help");
    assert.equal(help.submenu.find((item) => item.label === "About GitCat").role, "about");
  });
}
