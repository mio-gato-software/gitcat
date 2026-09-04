// Reproducible SVG -> PNG fallback using the Electron runtime already installed.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const profile = mkdtempSync(join(tmpdir(), 'gitcat-icon-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const [, , input, output] = process.argv;
  if (!input || !output) throw new Error('Expected SVG input and PNG output paths.');
  const win = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, frame: false, transparent: true, show: false, webPreferences: { offscreen: true } });
  const svg = readFileSync(input, 'utf8');
  await win.loadURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  if (size.width !== 1024 || size.height !== 1024 || image.isEmpty()) throw new Error('Icon render has an unexpected size.');
  writeFileSync(output, image.toPNG());
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => rmSync(profile, { recursive: true, force: true }));
