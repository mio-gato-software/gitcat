// Focused renderer regression: no personal settings, repositories, or network requests.
const electron = require('electron');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// Delete the disposable profile after Chromium releases its Windows file handles.
if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcat-welcome-'));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, GITCAT_WELCOME_PROFILE: profile }, windowsHide: true, stdio: 'inherit', timeout: 45000 });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const profile = process.env.GITCAT_WELCOME_PROFILE;
if (!profile) throw new Error('Run this check through Node to isolate and clean up its profile.');
app.setPath('userData', profile);
let gitMissing = false;
const errors = [];
const timer = setTimeout(() => { console.error('Welcome layout check timed out'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  ipcMain.handle('workspace:restore', () => ({ projects: [], unavailable: [], order: [] }));
  ipcMain.handle('workspace:save', () => {});
  ipcMain.handle('llm:get-config', () => ({ provider: 'openai', model: 'test', configured: false, secureStorage: true }));
  ipcMain.handle('operation:list', () => []);
  ipcMain.handle('readiness:check', () => ({ checkedAt: new Date().toISOString(), git: gitMissing ? { status: 'missing', searched: 0 } : { status: 'ok', version: 'test' } }));
  // Hosted Macs may have a small display; still exercise the requested desktop sizes.
  const win = new BrowserWindow({ width: 1480, height: 940, show: false, enableLargerThanScreen: true, webPreferences: { backgroundThrottling: false, preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, sandbox: true } });
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const ready = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await js(`Boolean(document.querySelector('.welcome-content'))`)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Welcome did not render');
  };
  await win.loadFile(path.join(root, 'dist/index.html'));
  for (const locale of ['en', 'es']) {
    await js(`localStorage.setItem('gitcat-locale', '${locale}')`);
    await win.loadFile(path.join(root, 'dist/index.html'));
    await ready();
    for (const [name, width, height, zoom] of [['wide', 1480, 940, 1], ['laptop', 1280, 800, 1], ['minimum', 1080, 700, 1], ['compact', 800, 700, 1], ['zoom', 1280, 800, 1.5]]) {
      win.webContents.setZoomFactor(zoom);
      win.setContentSize(width, height);
      // Zoom and native resizing are asynchronous. Wait for the actual viewport and
      // a rendered frame before asserting layout, including after a locale reload.
      const viewport = Math.round(width / zoom);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await js(`innerWidth === ${viewport}`)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(await js('innerWidth'), viewport, `${locale}/${name}: requested viewport`);
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const size = await js(`(() => {
        const card = document.querySelector('.first-run'); card.scrollTop = 0;
        const bounds = card.getBoundingClientRect();
        const primary = document.querySelector('.welcome-projects').getBoundingClientRect();
        const extra = document.querySelector('.welcome-extras').getBoundingClientRect();
        return { viewport: innerWidth, card: bounds.width, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: innerHeight,
          scrolls: card.scrollHeight > card.clientHeight + 1, horizontal: card.scrollWidth > card.clientWidth + 1,
          sideBySide: extra.left >= primary.right, stacked: extra.top >= primary.bottom,
          buttons: card.querySelectorAll('button').length };
      })()`);
      const label = `${locale}/${name}`;
      assert.equal(size.buttons, 5, `${label}: every first-run action remains available`);
      assert.equal(size.horizontal, false, `${label}: no horizontal overflow`);
      assert.ok(size.left >= 0 && size.right <= size.viewport && size.top >= 0 && size.bottom <= size.height, `${label}: card fits the window`);
      if (size.viewport > 900) {
        assert.ok(size.card >= Math.min(1000, size.viewport - 48), `${label}: use the desktop width`);
        assert.equal(size.sideBySide, true, `${label}: project actions and optional help sit side by side`);
        assert.equal(size.scrolls, false, `${label}: all actions are visible without scrolling`);
      } else {
        assert.equal(size.stacked, true, `${label}: sections stack at narrow widths or increased zoom`);
      }
      assert.equal(await js(`(() => {
        const card = document.querySelector('.first-run');
        return [...card.querySelectorAll('button')].every(button => {
          button.focus(); const r = button.getBoundingClientRect(), c = card.getBoundingClientRect();
          return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom;
        });
      })()`), true, `${label}: keyboard focus reveals every action`);
      if (process.env.GITCAT_UI_SCREENSHOTS && name === 'laptop') {
        await js(`document.activeElement.blur(); document.querySelector('.first-run').scrollTop = 0`);
        fs.mkdirSync(process.env.GITCAT_UI_SCREENSHOTS, { recursive: true });
        fs.writeFileSync(path.join(process.env.GITCAT_UI_SCREENSHOTS, `welcome-${locale}.png`), (await win.webContents.capturePage()).toPNG());
      }
      console.log(`${label}: layout passed`);
    }
  }
  gitMissing = true;
  await win.loadFile(path.join(root, 'dist/index.html'));
  await ready();
  assert.equal(await js(`document.querySelectorAll('.first-run .start-option').length`), 3, 'Missing Git keeps the start options available');
  assert.deepEqual(errors, [], 'Renderer has no console errors');
  win.destroy();
  clearTimeout(timer);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(timer); app.exit(1); });
