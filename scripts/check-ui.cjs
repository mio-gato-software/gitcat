// Renderer smoke test using an isolated, disposable Git repository and profile.
// Run with npm run test:ui; no personal repository, settings or API key is used.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcat-design-'));
const repo = path.join(scratch, 'GitCat');
const screenshots = process.env.GITCAT_UI_SCREENSHOTS;
fs.mkdirSync(repo);
app.setPath('userData', path.join(scratch, 'profile'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

app.whenReady().then(async () => {
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'GitCat QA');
  git('config', 'user.email', 'qa@example.test');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'base\n');
  git('add', '.'); git('commit', '-qm', 'Configurar GitCat (#11)');
  git('switch', '-qc', 'feature/search');
  fs.writeFileSync(path.join(repo, 'search.txt'), 'search\n');
  git('add', '.'); git('commit', '-qm', 'Añadir búsqueda al proyecto');
  git('switch', 'main');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'notifications\n');
  git('commit', '-am', 'Mejorar las notificaciones');
  git('merge', '--no-ff', 'feature/search', '-m', 'Integrar el buscador (#12)');
  git('switch', '-qc', 'feature/new-menu');
  fs.writeFileSync(path.join(repo, 'menu.txt'), 'menu\n');
  git('add', '.'); git('commit', '-qm', 'Añadir navegación al menú');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'updated menu\n');
  fs.writeFileSync(path.join(repo, 'new-file.txt'), 'new file\n');

  const service = await import(pathToFileURL(path.join(root, 'dist-electron/electron/git-service.js')));
  const snapshot = await service.getSnapshot(repo);
  const plans = new Map();
  let refreshError = false;
  ipcMain.handle('workspace:restore', () => ({ projects: [snapshot], activePath: repo }));
  ipcMain.handle('workspace:save', () => {});
  ipcMain.handle('llm:get-config', () => ({ provider: 'openai', model: 'ui-test', configured: true }));
  ipcMain.handle('history:load', (_, p, request) => service.loadHistory(p, request));
  ipcMain.handle('repo:snapshot', () => {
    if (refreshError) throw new Error('A long example error for notification layout. '.repeat(30));
    return service.getSnapshot(repo);
  });
  ipcMain.handle('commit:generate-description', async () => ({ description: 'Update menu and add a new file', stateId: (await service.getSnapshot(repo)).stateId }));
  ipcMain.handle('action:prepare-delivery', async (_, p, request, locale) => {
    const plan = await service.prepareBranchDelivery(p, request, locale);
    plans.set(plan.id, plan); return plan;
  });
  ipcMain.handle('action:execute', (_, p, id, locale) => service.executePlan(p, plans.get(id), locale));

  const win = new BrowserWindow({ width: 1480, height: 940, show: false, webPreferences: { preload: path.join(root, 'electron/preload.cjs') } });
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`UI did not become ready: ${expression}`);
  };
  const capture = async name => {
    if (!screenshots) return;
    fs.mkdirSync(screenshots, { recursive: true });
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const assertFits = async () => assert.deepEqual(await js(`(() => {
    const nodes = [...document.querySelectorAll('.workspace-actions button, .branch-work-actions button, .view-tab, .notification-bell, .chat-compose textarea, .send-button')];
    return nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth || r.width < 20 || r.bottom > innerHeight; }).map(node => node.textContent || node.getAttribute('aria-label'));
  })()`), [], 'Primary controls fit the window');

  await win.loadFile(path.join(root, 'dist/index.html'));
  await js(`localStorage.setItem('gitcat-locale', 'es')`);
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelectorAll('.commit-row').length === 5`);
  assert.equal(await js(`document.querySelector('h1').textContent`), 'Tu trabajo, en contexto');
  assert.equal(await js(`document.querySelector('.overview-details').open`), false);
  const before = git('status', '--porcelain');
  await js(`document.querySelector('.overview-details summary').click()`);
  assert.equal(await js(`document.querySelector('.overview-details').open`), true);
  assert.match(await js(`document.querySelector('.overview-details').innerText`), /no tiene una rama de seguimiento/);
  await js(`document.querySelector('.overview-details summary').click(); document.querySelector('.overview-legend summary').click()`);
  assert.equal(await js(`document.querySelector('.overview-legend').open`), true);
  assert.equal(git('status', '--porcelain'), before, 'Opening explanatory details never mutates Git');
  await js(`document.querySelector('.overview-legend summary').click()`);
  await assertFits(); await capture('overview');

  // A long error must stay in the reserved footer, with no layout movement.
  const box = () => js(`JSON.stringify(document.querySelector('.branch-work-card').getBoundingClientRect())`);
  const beforeNotification = await box();
  refreshError = true;
  await js(`document.querySelector('.workspace-actions button').click()`);
  await waitFor(`document.querySelector('.notification-preview.warning')`);
  assert.equal(await box(), beforeNotification);
  await js(`document.querySelector('.notification-bell').click()`);
  await waitFor(`document.querySelector('.notification-panel')`);
  await capture('notifications');
  await js(`document.querySelector('.notification-panel-header button:last-child').click()`);
  refreshError = false;

  // Minimum supported window and maximum saved pane widths exercise wrapping.
  win.setSize(1080, 720);
  await js(`localStorage.setItem('gitcat-pane-widths', JSON.stringify({ sidebar: 460, inspector: 620 }))`);
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelectorAll('.commit-row').length === 5`);
  await assertFits(); await capture('compact');
  await js(`localStorage.removeItem('gitcat-pane-widths')`);
  win.setSize(1480, 940);
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.branch-work-actions .primary-button')`);

  await js(`document.querySelector('.branch-work-actions .primary-button').click()`);
  await waitFor(`document.querySelector('#commit-description')?.value === 'Update menu and add a new file'`);
  assert.equal(await js(`document.querySelector('.delivery-option input').checked`), true);
  assert.match(await js(`document.querySelector('.change-list').innerText`), /Nuevo · incluido/);
  await capture('changes');
  await js(`document.querySelector('.commit-form-actions button').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal')`);
  await capture('review');
  assert.equal(git('branch', '--show-current'), 'feature/new-menu');
  assert.equal(git('status', '--porcelain'), before, 'Review must precede all Git changes');
  await js(`document.querySelector('.delivery-review-modal .plan-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.branch-work-card.is-saved')`);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('show', 'main:new-file.txt'), 'new file');
  win.destroy();
  console.log('PASS: disclosures, graph, compact layout, stable notifications, reviewed save and integration.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
