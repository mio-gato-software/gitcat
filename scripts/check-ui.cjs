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
  ipcMain.handle('commit:detail', (_, p, hash) => service.getCommitDetail(p, hash));
  ipcMain.handle('commit:file-diff', (_, p, file) => service.getWorkingFileDiff(p, file));
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
  ipcMain.handle('action:prepare', async (_, p, operation, args, locale) => {
    const plan = await service.prepareOperation(p, operation, args, locale);
    plans.set(plan.id, plan); return plan;
  });

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
    const nodes = [...document.querySelectorAll('.tool-button, .delivery-actions button, .inspector-tabs button, .commit-search, .notification-bell, .chat-compose textarea, .send-button')];
    return nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth || r.width < 20 || r.bottom > innerHeight; }).map(node => node.textContent || node.getAttribute('aria-label'));
  })()`), [], 'Primary controls fit the window');

  await win.loadFile(path.join(root, 'dist/index.html'));
  await js(`localStorage.setItem('gitcat-locale', 'es')`);
  await win.loadFile(path.join(root, 'dist/index.html'));
  // Five commits plus the uncommitted work, drawn as its own row above HEAD.
  await waitFor(`document.querySelectorAll('.commit-row').length === 6`);
  const before = git('status', '--porcelain');
  assert.equal(await js(`document.querySelector('.commit-row').classList.contains('wip')`), true);
  assert.match(await js(`document.querySelector('.commit-row.wip').innerText`), /WIP/);
  // Every commit says how much it changed, without opening it.
  assert.match(await js(`document.querySelector('.commit-row.head .commit-changes').innerText`), /\+1/);
  // Nothing picked yet: the details pane shows the uncommitted work and its files.
  await waitFor(`document.querySelector('.inspector .changes-view .change-list')`);
  assert.match(await js(`document.querySelector('.inspector .change-summary').innerText`), /1 modificado\n1 añadido/);
  assert.equal(await js(`document.querySelectorAll('.inspector .change-row').length`), 2);
  // Picking a commit shows its message, author and files with their line counts.
  await js(`document.querySelectorAll('.commit-row')[2].click()`);
  await waitFor(`document.querySelector('.commit-inspector .change-row')`);
  assert.match(await js(`document.querySelector('.commit-inspector .detail-message').innerText`), /Integrar el buscador/);
  assert.match(await js(`document.querySelector('.commit-inspector .change-list').innerText`), /search\.txt/);
  await capture('overview-commit');
  // The tree view groups the same files by folder, and the choice is remembered.
  await js(`document.querySelectorAll('.file-list .mode-toggle button')[1].click()`);
  assert.equal(await js(`localStorage.getItem('gitcat-file-list-mode')`), 'tree');
  await js(`document.querySelectorAll('.file-list .mode-toggle button')[0].click()`);
  // Arrow keys walk the graph and the details follow.
  await js(`document.querySelectorAll('.commit-row')[2].querySelector('.commit-content').focus()`);
  await js(`document.querySelector('.graph-scroll').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
  await waitFor(`document.querySelectorAll('.commit-row')[1].classList.contains('selected')`);
  await js(`document.querySelector('.commit-row.wip').click()`);
  await waitFor(`document.querySelector('.inspector .changes-view')`);
  // The new-project button shares the tabs' vertical centre.
  const centres = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.window-tab, .tab-add')].map((node) => { const r = node.getBoundingClientRect(); return r.top + r.height / 2; }))`));
  assert.ok(Math.abs(centres[0] - centres[centres.length - 1]) <= 1, `tab centres ${centres}`);
  // A right click on a commit with a branch offers that branch's actions and the commit's own.
  await js(`(() => { const row = [...document.querySelectorAll('.commit-row')].find((node) => node.querySelector('.ref-tag')?.textContent === 'main'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 300 })); })()`);
  await waitFor(`document.querySelector('.context-menu')`);
  const menuText = await js(`document.querySelector('.context-menu').innerText`);
  for (const entry of [/Cambiar a la rama main/, /Mover feature\/new-menu encima de main/, /Nueva rama desde este commit/, /Deshacer este commit/, /Copiar el hash/]) assert.match(menuText, entry);
  // main is already inside feature/new-menu, so a merge would bring nothing and is not offered.
  assert.doesNotMatch(menuText, /Fusionar main en/);
  assert.doesNotMatch(menuText, /Eliminar la rama main|Renombrar/, 'The default branch is never offered for deletion or renaming');
  await capture('context-menu');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(`!document.querySelector('.context-menu')`);
  // The WIP row has its own short menu.
  await js(`document.querySelector('.commit-row.wip').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 200 }))`);
  await waitFor(`document.querySelector('.context-menu')`);
  assert.match(await js(`document.querySelector('.context-menu').innerText`), /Guardar cambios/);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  // The branch panel can step aside and come back, and the choice is remembered.
  const graphWidth = () => js(`document.querySelector('.graph-area').getBoundingClientRect().width`);
  const withPanel = await graphWidth();
  await js(`document.querySelector('[aria-label="Ocultar el panel de ramas"]').click()`);
  await waitFor(`!document.querySelector('.sidebar')`);
  assert.ok(await graphWidth() > withPanel + 150, 'The graph takes the branch panel column');
  assert.equal(await js(`localStorage.getItem('gitcat-branch-panel')`), 'hidden');
  await capture('panel-hidden');
  await js(`document.querySelector('[aria-label="Mostrar el panel de ramas"]').click()`);
  await waitFor(`document.querySelector('.sidebar')`);
  assert.equal(git('status', '--porcelain'), before, 'Reading the graph and its details never mutates Git');
  // Refresh answers "am I up to date?" on its own, so there is no separate Fetch button beside it.
  assert.deepEqual(JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.toolbar-tools .tool-button')].map((node) => node.innerText.trim()))`)), ['Actualizar', 'Pull', 'Push', 'Rama']);
  await assertFits(); await capture('overview');

  // A long error must stay in the reserved footer, with no layout movement.
  const box = () => js(`JSON.stringify(document.querySelector('.repo-toolbar').getBoundingClientRect())`);
  const beforeNotification = await box();
  refreshError = true;
  await js(`document.querySelector('.tool-button').click()`);
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
  await waitFor(`document.querySelectorAll('.commit-row').length === 6`);
  await assertFits(); await capture('compact');
  await js(`localStorage.removeItem('gitcat-pane-widths')`);
  win.setSize(1480, 940);
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.delivery-actions .primary-button')`);

  await js(`document.querySelector('.delivery-actions .primary-button').click()`);
  await waitFor(`document.querySelector('#commit-description')?.value === 'Update menu and add a new file'`);
  assert.equal(await js(`document.querySelector('.delivery-option input').checked`), true);
  assert.match(await js(`document.querySelector('.inspector .change-row[title^="Nuevo · incluido"]').innerText`), /new-file\.txt/);
  await capture('changes');
  await js(`document.querySelector('.commit-form-actions button').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal')`);
  await capture('review');
  assert.equal(git('branch', '--show-current'), 'feature/new-menu');
  assert.equal(git('status', '--porcelain'), before, 'Review must precede all Git changes');
  await js(`document.querySelector('.delivery-review-modal .plan-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.toolbar-delivery.is-saved')`);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('show', 'main:new-file.txt'), 'new file');
  // Double-clicking a branch label in the graph checks that branch out.
  await waitFor(`[...document.querySelectorAll('.ref-tag')].some((node) => node.textContent === 'feature/search')`);
  await js(`[...document.querySelectorAll('.ref-tag')].find((node) => node.textContent === 'feature/search').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  for (let attempt = 0; attempt < 100 && git('branch', '--show-current') !== 'feature/search'; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(git('branch', '--show-current'), 'feature/search');
  await waitFor(`document.querySelector('.toolbar-field.branch strong')?.textContent === 'feature/search'`);
  // Work done outside GitCat appears on its own when the window comes back, without pressing Refresh.
  assert.equal(await js(`Boolean(document.querySelector('.activity-strip'))`), false, 'No branch review strip');
  git('branch', 'outside/terminal');
  // A read is skipped while GitCat is still finishing the checkout, so focus is offered until one lands.
  await waitFor(`document.querySelector('aside.sidebar').textContent.includes('outside') || (window.dispatchEvent(new Event('focus')), false)`);
  win.destroy();
  console.log('PASS: graph with work in progress, commit details, context menus, collapsible branch panel, compact layout, stable notifications, reviewed save and integration, double-click checkout, background refresh.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
