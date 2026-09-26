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
  // A second saved project whose folder is gone: it must stay listed and explain itself instead of vanishing.
  const movedPath = path.join(scratch, 'Moved project');
  const moved = () => ({ path: movedPath, name: 'Moved project', reason: 'missing', detail: `ENOENT: ${movedPath}`, checkedAt: new Date().toISOString() });
  let retries = 0;
  // The last scenario swaps in a repository stopped in a merge, with no assistant configured.
  let restored = null;
  let configured = true;
  ipcMain.handle('workspace:restore', () => restored ?? ({ projects: [snapshot], unavailable: [moved()], order: [snapshot.path, movedPath], activePath: snapshot.path }));
  ipcMain.handle('workspace:retry', () => { retries += 1; return { unavailable: moved() }; });
  ipcMain.handle('workspace:save', () => {});
  ipcMain.handle('llm:get-config', () => ({ provider: 'openai', model: 'ui-test', configured }));
  ipcMain.handle('history:load', (_, p, request) => service.loadHistory(p, request));
  ipcMain.handle('commit:detail', (_, p, hash) => service.getCommitDetail(p, hash));
  ipcMain.handle('commit:file-diff', (_, p, file) => service.getWorkingFileDiff(p, file));
  ipcMain.handle('repo:snapshot', (_, p) => {
    if (refreshError) throw new Error('A long example error for notification layout. '.repeat(30));
    return service.getSnapshot(p || repo);
  });
  // The guided resolver runs on the real service; guides are kept here the way the main process keeps them.
  const guides = new Map();
  const opened = [];
  let proposals = 0;
  ipcMain.handle('conflicts:describe', async (_, p, locale) => {
    const guide = await service.describeConflicts(p, locale);
    guides.set(guide.id, guide);
    const shown = { ...guide };
    delete shown.binding;
    return shown;
  });
  ipcMain.handle('conflicts:choose', (_, p, id, choices, locale) => service.applyConflictChoices(p, guides.get(id), choices, locale));
  ipcMain.handle('conflicts:open', async (_, p, file, locale) => { opened.push(await service.conflictFileToOpen(p, file, locale)); });
  ipcMain.handle('conflicts:propose', () => { proposals += 1; throw new Error('no provider in this scenario'); });
  // The description is written from the ticked files only; the stub records which ones it was asked about.
  const described = [];
  ipcMain.handle('commit:generate-description', async (_, p, locale, paths) => {
    described.push([...paths].sort());
    const current = await service.getSnapshot(repo);
    return { description: 'Update menu and add a new file', stateId: current.stateId, selection: current.changes.filter((change) => paths.includes(change.path)).map((change) => ({ path: change.path, version: change.version })) };
  });
  ipcMain.handle('commit:selection-diff', (_, p, paths, locale) => service.getSelectionDiff(p, paths, locale));
  // Sharing decisions and the secret check are the real service's, kept in this disposable profile.
  ipcMain.handle('sharing:get', (_, p, purpose, paths, locale) => service.getAiSharing(p, purpose, paths, locale));
  ipcMain.handle('sharing:acknowledge', (_, p) => service.acknowledgeAiSharing(p));
  ipcMain.handle('sharing:set-exclusions', (_, p, exclusions, locale) => service.setAiSharingExclusions(p, exclusions, locale));
  ipcMain.handle('sharing:review', (_, p, file, share, locale) => service.setAiSharingReview(p, file, share, locale));
  ipcMain.handle('changes:scan-secrets', (_, p) => service.scanChangesForSecrets(p));
  ipcMain.handle('action:prepare-delivery', async (_, p, request, locale) => {
    const plan = await service.prepareBranchDelivery(p, request, locale);
    plans.set(plan.id, plan); return plan;
  });
  // Like the main process, a plan that stops is kept with what each step did, so recovery reads facts.
  const failed = new Map();
  let recoverCalls = 0;
  ipcMain.handle('action:execute', async (_, p, id, locale) => {
    const plan = plans.get(id);
    const result = await service.executePlan(p, plan, locale);
    if (result.error) failed.set(id, { plan, outcomes: result.outcomes, stale: false });
    return result;
  });
  ipcMain.handle('action:describe-failure', (_, p, failure) => service.describeFailure(p, failure, failure.planId ? failed.get(failure.planId) : undefined));
  ipcMain.handle('action:recover', (_, p, failure, context, locale) => { recoverCalls += 1; return service.planRecovery(p, failure, context, locale); });
  ipcMain.handle('action:prepare-retry', async (_, p, id, locale) => {
    const plan = await service.prepareRetry(p, failed.get(id), locale);
    plans.set(plan.id, plan); return plan;
  });
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
    if (process.env.GITCAT_UI_DEBUG) console.error((await js(`document.body.innerText`)).slice(0, 3000));
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
  // The unavailable project keeps its tab, says what happened and offers every way on.
  assert.equal(await js(`document.querySelectorAll('.window-tab.unavailable').length`), 1);
  await js(`document.querySelector('.window-tab.unavailable [role="tab"]').click()`);
  await waitFor(`document.querySelector('.unavailable-project')`);
  const unavailableText = await js(`document.querySelector('.unavailable-project').innerText`);
  for (const entry of [/No hay ninguna carpeta/, /Moved project/, /Localizar carpeta movida/, /Reintentar/, /Quitar de proyectos recientes/, /No se cambió ni se borró nada/]) assert.match(unavailableText, entry);
  await capture('unavailable-project');
  await js(`[...document.querySelectorAll('.unavailable-project button')].find((node) => node.innerText.includes('Reintentar')).click()`);
  for (let attempt = 0; attempt < 100 && retries === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(retries, 1);
  await waitFor(`document.querySelector('.notification-preview.warning')`);
  assert.equal(await js(`Boolean(document.querySelector('.unavailable-project'))`), true, 'A failed retry keeps the project listed');
  await js(`document.querySelector('.window-tab:not(.unavailable) [role="tab"]').click()`);
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
  // Refresh answers "am I up to date?" on its own; Fetch stays beside it because people look for it by name.
  assert.deepEqual(JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.toolbar-tools .tool-button')].map((node) => node.innerText.trim()))`)), ['Actualizar', 'Fetch', 'Pull', 'Push', 'Rama']);
  // Graph columns resize from their header edges, remember the width, and reset on a double click.
  const refsCell = () => js(`Math.round(document.querySelector('.graph-columns > span').getBoundingClientRect().width)`);
  const rowRefs = () => js(`Math.round(document.querySelector('.commit-row .commit-refs').getBoundingClientRect().width)`);
  const refsBefore = await refsCell();
  await js(`document.querySelector('.graph-columns > span:first-child .column-grip').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await waitFor(`Math.round(document.querySelector('.graph-columns > span').getBoundingClientRect().width) === ${refsBefore + 16}`);
  assert.equal(await rowRefs(), refsBefore + 16, 'Every row follows the header width');
  assert.equal(JSON.parse(await js(`localStorage.getItem('gitcat-graph-columns')`)).refs, refsBefore + 16);
  await js(`document.querySelector('.graph-columns > span:first-child .column-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(`Math.round(document.querySelector('.graph-columns > span').getBoundingClientRect().width) === ${refsBefore}`);
  assert.equal(JSON.parse(await js(`localStorage.getItem('gitcat-graph-columns')`)).refs, undefined);
  // A real pointer drag on the leading edge of Changes widens that column leftwards.
  const changesCell = () => js(`Math.round(document.querySelector('.graph-columns .col-changes').getBoundingClientRect().width)`);
  const changesBefore = await changesCell();
  const grip = JSON.parse(await js(`JSON.stringify(document.querySelector('.graph-columns .col-changes .column-grip').getBoundingClientRect())`));
  const gx = Math.round(grip.x + grip.width / 2); const gy = Math.round(grip.y + grip.height / 2);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: gx, y: gy, button: 'left', clickCount: 1 });
  for (const step of [10, 20, 30, 40]) win.webContents.sendInputEvent({ type: 'mouseMove', x: gx - step, y: gy, button: 'left', modifiers: ['leftButtonDown'] });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: gx - 40, y: gy, button: 'left', clickCount: 1 });
  await waitFor(`JSON.parse(localStorage.getItem('gitcat-graph-columns') ?? '{}').changes === ${changesBefore + 40}`);
  assert.equal(await changesCell(), changesBefore + 40);
  await js(`document.querySelector('.graph-columns .col-changes .column-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(`Math.round(document.querySelector('.graph-columns .col-changes').getBoundingClientRect().width) === ${changesBefore}`);
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

  // Each listed file has its own tick; leaving one out is visible and the count follows.
  const rowFor = (name) => `[...document.querySelectorAll('.inspector .change-row')].find((node) => node.innerText.includes('${name}'))`;
  await waitFor(`${rowFor('new-file.txt')}?.querySelector('.change-include')`);
  assert.equal(await js(`${rowFor('app.txt')}.querySelector('.change-ignore') === null`), true, 'A tracked file offers no ignore rule');
  await js(`${rowFor('new-file.txt')}.querySelector('.change-include').click()`);
  await waitFor(`document.querySelector('.inspector .select-all')?.innerText.includes('Se guardarán 1 de 2 archivos')`);
  assert.match(await js(`${rowFor('new-file.txt')}.title`), /^Nuevo · fuera/);
  assert.equal(await js(`${rowFor('new-file.txt')}.classList.contains('excluded')`), true);
  // What will be saved is shown as one diff of the ticked files only.
  await js(`[...document.querySelectorAll('.commit-form-actions button')].find((node) => node.innerText.includes('Ver lo que se guardará')).click()`);
  await waitFor(`document.querySelector('.selection-diff-modal .diff-view')`);
  const selectedDiff = await js(`document.querySelector('.selection-diff-modal .diff-view').innerText`);
  assert.match(selectedDiff, /updated menu/); assert.doesNotMatch(selectedDiff, /new-file/);
  await capture('selected-diff');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(`!document.querySelector('.selection-diff-modal')`);
  // Ignoring an untracked file previews the exact .gitignore line and writes nothing until confirmed.
  await js(`${rowFor('new-file.txt')}.querySelector('.change-ignore').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal')`);
  const ignoreReview = await js(`document.querySelector('.delivery-review-modal').innerText`);
  assert.match(ignoreReview, /\/new-file\.txt/); assert.match(ignoreReview, /ya están guardados en Git se siguen vigilando/);
  await js(`document.querySelector('.delivery-review-modal .modal-heading .icon-button').click()`);
  await waitFor(`!document.querySelector('.delivery-review-modal')`);
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false, 'Closing the preview writes nothing');

  // Opening the save sends nothing before sharing is agreed: the form stays manual until asked.
  await js(`document.querySelector('.delivery-actions .primary-button').click()`);
  await waitFor(`document.querySelector('#commit-description')`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(described.length, 0, 'No description is requested before the disclosure');
  assert.equal(await js(`document.querySelector('#commit-description').value`), '');
  // Asking for one shows what would leave this Mac, file by file, before anything is sent.
  await js(`document.querySelector('.commit-form-heading button').click()`);
  await waitFor(`document.querySelector('.sharing-modal')`);
  const disclosure = await js(`document.querySelector('.sharing-modal').innerText`);
  for (const entry of [/Antes de que el asistente lea GitCat/, /OpenAI \([^,)]+, api\.openai\.com\)/, /app\.txt/, /Se envía/, /No compartir nunca de este repositorio/, /no demuestra que un repositorio sea seguro/, /No necesitas el asistente/]) assert.match(disclosure, entry);
  assert.doesNotMatch(disclosure, /new-file\.txt/, 'Only the ticked files are part of the description request');
  assert.equal(described.length, 0, 'Still nothing sent while the disclosure is open');
  await capture('sharing-disclosure');
  await js(`document.querySelector('.sharing-modal .sharing-accept').click()`);
  await waitFor(`document.querySelector('#commit-description')?.value === 'Update menu and add a new file'`);
  assert.deepEqual(described.at(-1), ['app.txt'], 'The description reads only the ticked files');
  await js(`${rowFor('new-file.txt')}.querySelector('.change-include').click()`);
  await waitFor(`document.querySelector('.inspector .select-all')?.innerText.includes('Se guardarán 2 de 2 archivos')`);
  assert.equal(await js(`document.querySelector('.delivery-option input').checked`), true);
  assert.match(await js(`document.querySelector('.inspector .change-row[title^="Nuevo · incluido"]').innerText`), /new-file\.txt/);
  await capture('changes');
  await js(`document.querySelector('.commit-form-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal')`);
  await capture('review');
  assert.equal(git('branch', '--show-current'), 'feature/new-menu');
  assert.equal(git('status', '--porcelain'), before, 'Review must precede all Git changes');
  await js(`document.querySelector('.delivery-review-modal .plan-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.toolbar-delivery.is-saved')`);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('show', 'main:new-file.txt'), 'new file');
  // A push with nowhere to go is explained from the repository itself, with the way on, and the
  // assistant is not needed for it: no provider request is made.
  const headBeforePush = git('rev-parse', 'HEAD');
  await js(`[...document.querySelectorAll('.toolbar-tools .tool-button')].find((node) => node.innerText.trim() === 'Push').click()`);
  await waitFor(`document.querySelector('.plan-card .plan-actions .primary-button')`);
  await js(`document.querySelector('.plan-card .plan-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.recovery-card[data-kind="no_remote"]')`);
  const recoveryText = await js(`document.querySelector('.recovery-card[data-kind="no_remote"]').innerText`);
  for (const entry of [/aún no tiene dónde publicarse/, /Comprobado en este Mac/, /Se detuvo aquí/, /Tus commits están a salvo/, /Conectar un remoto/]) assert.match(recoveryText, entry);
  assert.equal(recoverCalls, 0, 'A failure GitCat can prove needs no assistant');
  await js(`document.querySelector('.recovery-card').scrollIntoView()`);
  await capture('recovery-card');
  await js(`[...document.querySelectorAll('.recovery-card .recovery-actions button')].find((node) => node.innerText.includes('Conectar un remoto')).click()`);
  await waitFor(`document.querySelector('.input-modal')?.innerText.includes('Dirección del remoto')`);
  await js(`document.querySelector('.input-modal .modal-heading .icon-button').click()`);
  await waitFor(`!document.querySelector('.input-modal')`);
  assert.equal(git('remote'), '', 'Offering a way on changes nothing');
  assert.equal(git('rev-parse', 'HEAD'), headBeforePush);
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
  // A new .env with a key is flagged beside the files to save, by file and kind only, before any review.
  fs.writeFileSync(path.join(repo, '.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
  await js(`document.querySelector('.inspector-tabs button').click()`);
  await waitFor(`document.querySelector('.secret-warning') || (window.dispatchEvent(new Event('focus')), false)`);
  const warning = await js(`document.querySelector('.secret-warning').innerText`);
  for (const entry of [/parecen contener una contraseña/, /\.env/, /clave de acceso de AWS/, /Dejar fuera/, /Ignorar archivo/, /Revisé estos archivos/]) assert.match(warning, entry);
  assert.doesNotMatch(await js(`document.body.innerText`), /AKIAIOSFODNN7EXAMPLE/, 'The secret itself is never shown');
  assert.match(await js(`document.querySelector('.inspector .change-row .change-badge.secret').textContent`), /posible secreto/);
  await capture('secret-warning');

  // A merge that stopped on a text conflict, a modify/delete and a binary file, with no assistant
  // configured: the resolver explains both versions by name and settles everything on its own.
  const conflictRepo = path.join(scratch, 'Conflicts');
  fs.mkdirSync(conflictRepo);
  const cgit = (...args) => execFileSync('git', args, { cwd: conflictRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const cwrite = (file, content) => fs.writeFileSync(path.join(conflictRepo, file), content);
  cgit('init', '-q', '-b', 'main'); cgit('config', 'user.name', 'GitCat QA'); cgit('config', 'user.email', 'qa@example.test');
  cwrite('text.txt', 'uno\ndos\n'); cwrite('gone.txt', 'base\n'); cwrite('logo.png', Buffer.from([0x89, 0x50, 0, 1, 2]));
  cgit('add', '.'); cgit('commit', '-qm', 'Base');
  cgit('switch', '-qc', 'otra');
  cwrite('text.txt', 'uno\nDOS de otra\n'); cgit('rm', '-q', 'gone.txt'); cwrite('logo.png', Buffer.from([0x89, 0x50, 0, 3, 4]));
  cgit('add', '-A'); cgit('commit', '-qm', 'Cambios en otra');
  cgit('switch', '-q', 'main');
  cwrite('text.txt', 'uno\nDOS de main\n'); cwrite('gone.txt', 'cambiado en main\n'); cwrite('logo.png', Buffer.from([0x89, 0x50, 0, 5, 6]));
  cgit('add', '-A'); cgit('commit', '-qm', 'Cambios en main');
  try { cgit('merge', 'otra'); } catch { /* the conflict is the point */ }
  const conflicted = await service.getSnapshot(conflictRepo);
  restored = { projects: [conflicted], unavailable: [], order: [conflicted.path], activePath: conflicted.path };
  configured = false;
  await win.loadFile(path.join(root, 'dist/index.html'));
  // Without a provider GitCat first says so, and offers to go on without one.
  await waitFor(`[...document.querySelectorAll('button')].some((node) => node.innerText.includes('Ver la interfaz sin configurar'))`);
  await js(`[...document.querySelectorAll('button')].find((node) => node.innerText.includes('Ver la interfaz sin configurar')).click()`);
  await waitFor(`document.querySelector('.rebase-banner .guide-open')`);
  const banner = await js(`document.querySelector('.rebase-banner').innerText`);
  assert.match(banner, /Fusión en curso/); assert.match(banner, /3 archivos en conflicto/);
  assert.doesNotMatch(banner, /Proponer resolución/, 'No assistant, no draft button');
  await js(`document.querySelector('.rebase-banner .guide-open').click()`);
  await waitFor(`document.querySelector('.conflict-guide .guide-file')`);
  const guideText = await js(`document.querySelector('.conflict-guide').innerText`);
  for (const entry of [/Fusionando otra en main/, /La rama en la que estás/, /La rama que se está fusionando/, /Cambios en otra/, /Git: «theirs»/,
    /main cambió este archivo; otra lo borró/, /No es texto plano/, /No hay asistente configurado/, /Continuar crea el commit de fusión/, /Abortar vuelve exactamente/]) assert.match(guideText, entry);
  assert.doesNotMatch(guideText, /Pedir un borrador/);
  const fileCard = (file) => `document.querySelector('.guide-file[data-path="${file}"]')`;
  const choose = (file, label) => js(`[...${fileCard(file)}.querySelectorAll('.guide-choices label')].find((node) => node.innerText.includes(${JSON.stringify(label)})).querySelector('input').click()`);
  const labels = (file) => js(`[...${fileCard(file)}.querySelectorAll('.guide-choices label')].map((node) => node.innerText.trim())`);
  assert.deepEqual(await labels('logo.png'), ['Conservar la versión de main', 'Conservar la versión de otra'], 'A binary file is taken whole');
  assert.deepEqual(await labels('gone.txt'), ['Conservar la versión de main', 'Mantenerlo borrado', 'Lo edité yo']);
  await js(`[...${fileCard('text.txt')}.querySelectorAll('button')].find((node) => node.innerText.includes('Comparar versiones')).click()`);
  await waitFor(`${fileCard('text.txt')}.querySelector('.guide-versions')`);
  const versions = await js(`${fileCard('text.txt')}.querySelector('.guide-versions').innerText`);
  assert.match(versions, /DOS de main/); assert.match(versions, /DOS de otra/);
  await js(`[...${fileCard('text.txt')}.querySelectorAll('button')].find((node) => node.innerText.includes('Abrir en el editor')).click()`);
  for (let attempt = 0; attempt < 100 && !opened.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(opened, [fs.realpathSync(path.join(conflictRepo, 'text.txt'))]);
  await choose('text.txt', 'Conservar la versión de otra');
  await choose('gone.txt', 'Mantenerlo borrado');
  await choose('logo.png', 'Conservar la versión de main');
  assert.match(await js(`${fileCard('text.txt')}.querySelector('.guide-effect').innerText`), /exactamente como en otra\. Lo que main cambió/);
  await capture('conflict-guide');
  // The file is edited in the editor after the versions were shown: taking a side must not overwrite it.
  cwrite('text.txt', 'uno\nDOS de main y de otra\n');
  await js(`document.querySelector('.conflict-guide .guide-apply').click()`);
  await waitFor(`document.querySelector('.conflict-guide .guide-outcome')?.innerText.includes('cambiaron después de mostrarse')`);
  assert.equal(fs.readFileSync(path.join(conflictRepo, 'text.txt'), 'utf8'), 'uno\nDOS de main y de otra\n', 'The edit is kept');
  assert.match(cgit('ls-files', '-u'), /gone\.txt/, 'Nothing was written');
  await waitFor(`${fileCard('text.txt')}?.querySelector('.guide-clean') && !${fileCard('text.txt')}.querySelector('.guide-effect')`);
  await choose('text.txt', 'Lo edité yo');
  await waitFor(`document.querySelector('.conflict-guide .guide-apply')?.innerText.includes('3 archivos')`);
  await js(`document.querySelector('.conflict-guide .guide-apply').click()`);
  await waitFor(`document.querySelector('.conflict-guide')?.innerText.includes('Todos los conflictos están resueltos')`);
  assert.equal(cgit('ls-files', '-u'), '');
  assert.equal(fs.existsSync(path.join(conflictRepo, 'gone.txt')), false);
  assert.match(await js(`document.querySelector('.conflict-guide .guide-outcome').innerText`), /Marcados como resueltos: gone\.txt, logo\.png, text\.txt/);
  // Continuing is still a plan that says what it does and waits for confirmation.
  await js(`[...document.querySelectorAll('.conflict-guide .guide-next-actions button')].find((node) => node.innerText.trim() === 'Continuar').click()`);
  await waitFor(`document.querySelector('.plan-card .plan-effects')?.innerText.includes('Crea el commit de fusión')`);
  await js(`document.querySelector('.plan-card .plan-actions .primary-button').click()`);
  for (let attempt = 0; attempt < 100 && cgit('rev-list', '--count', 'HEAD') !== '4'; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(cgit('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'The merge commit was created');
  assert.equal(cgit('status', '--porcelain'), '');
  await waitFor(`!document.querySelector('.rebase-banner') && !document.querySelector('.plan-card .plan-actions .primary-button')`);
  assert.equal(proposals, 0, 'No provider was needed at any point');
  win.destroy();
  console.log('PASS: unavailable saved project kept with retry, graph with work in progress, commit details, context menus, collapsible branch panel, compact layout, stable notifications, per-file include/exclude with selected diff and description, previewed .gitignore rule, AI sharing disclosure before the first description, reviewed save and integration, failed push recovered without the assistant, double-click checkout, background refresh, local secret warning, guided conflict resolution without an assistant.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
