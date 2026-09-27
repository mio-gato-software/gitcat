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
// Git reads a disposable global configuration and no system one, so this Mac's own identity and
// helpers never leak into what the checks show, and setting a global identity writes only here.
const globalGitConfig = path.join(scratch, 'global.gitconfig');
fs.writeFileSync(globalGitConfig, '');
process.env.GIT_CONFIG_GLOBAL = globalGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
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
  // The fresh-profile scenario drives the guided connection against scripted answers; nothing reaches a provider.
  let secureStorage = true;
  let connected = false;
  const connectAnswers = [];
  const connectRequests = [];
  const openedPages = [];
  const llmConfig = () => ({ provider: 'openai', model: configured ? 'ui-test' : 'gpt-5.6-luna', configured: configured || connected, secureStorage });
  ipcMain.handle('llm:get-config', () => llmConfig());
  ipcMain.handle('llm:save-config', (_, input) => {
    connectRequests.push({ model: input.model, hasKey: Boolean(input.apiKey) });
    const answer = connectAnswers.shift() ?? { ok: true };
    if (answer.ok) connected = true;
    return answer.ok ? { ok: true, config: llmConfig() } : { ok: false, config: llmConfig(), problem: { kind: answer.kind, detail: answer.detail ?? '', at: new Date().toISOString() } };
  });
  ipcMain.handle('llm:verify', () => ({ ok: true, config: llmConfig() }));
  ipcMain.handle('llm:open-provider-page', (_, page) => { openedPages.push(page); });
  // Readiness is the real, read-only service. None of these repositories point at a network host.
  const readinessRequests = [];
  ipcMain.handle('readiness:check', (_, p, request) => {
    readinessRequests.push({ path: p ?? null, access: request?.access === true });
    return service.checkReadiness(p ?? undefined, { ...(request?.remote ? { remote: request.remote } : {}), access: request?.access === true });
  });
  const helpPages = [];
  ipcMain.handle('help:open-page', (_, page) => { helpPages.push(page); });
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

  // Getting a first project in runs on the real setup service against disposable folders. The only
  // stand-ins are the system dialogs (their answer is set per step) and one address mapped to a local
  // empty repository, because a person's clone never reads local paths.
  const setupService = await import(pathToFileURL(path.join(root, 'dist-electron/electron/project-setup.js')));
  const setupRoot = path.join(scratch, 'setup');
  fs.mkdirSync(setupRoot);
  const pendingSetups = new Map();
  let nextFolder = null;
  let cloneParent = null;
  let cloneController = null;
  const emptyRemote = path.join(setupRoot, 'empty-remote.git');
  const emptyRemoteUrl = 'https://example.test/octo/empty-start.git';
  const selectResult = async (folder, intent) => {
    const inspection = await setupService.inspectFolder(folder);
    if (inspection.kind === 'repository') return { status: 'opened', project: await service.getSnapshot(inspection.root) };
    const setupId = `setup-${pendingSetups.size + 1}`;
    if (inspection.kind === 'folder') { pendingSetups.set(setupId, inspection.preview); return { status: 'not_repository', setupId, preview: inspection.preview, intent }; }
    if (inspection.kind === 'inside_repository') return { status: 'inside_repository', setupId, path: inspection.path, root: inspection.root, rootName: path.basename(inspection.root) };
    return { status: 'invalid', path: inspection.path, problem: inspection.problem };
  };
  ipcMain.handle('project:select', (_, intent) => nextFolder ? selectResult(nextFolder, intent === 'track' ? 'track' : 'open') : { status: 'canceled' });
  ipcMain.handle('project:start-tracking', async (_, setupId) => {
    const preview = pendingSetups.get(setupId);
    const outcome = await setupService.startTracking(preview.path, { branch: preview.branch });
    return outcome.status === 'started' ? { status: 'started', project: await service.getSnapshot(outcome.root) } : outcome;
  });
  ipcMain.handle('clone:choose-parent', () => ({ status: 'chosen', parentId: 'parent-1', path: cloneParent }));
  ipcMain.handle('clone:preview', (_, url, _id, name) => setupService.previewClone({ url, parent: cloneParent, name }));
  ipcMain.handle('clone:start', async (_, url, _id, name) => {
    const controller = cloneController = new AbortController();
    const local = url === emptyRemoteUrl;
    const outcome = await setupService.cloneRepository({ url: local ? emptyRemote : url, parent: cloneParent, name }, { signal: controller.signal, allowLocalSource: local });
    cloneController = null;
    return outcome.status === 'cloned' ? { status: 'cloned', project: await service.getSnapshot(outcome.path), empty: outcome.empty } : outcome;
  });
  ipcMain.handle('clone:cancel', () => { cloneController?.abort(); return Boolean(cloneController); });

  const win = new BrowserWindow({ width: 1480, height: 940, show: false, webPreferences: { preload: path.join(root, 'electron/preload.cjs') } });
  const js = code => win.webContents.executeJavaScript(code).catch((error) => { if (process.env.GITCAT_UI_DEBUG) console.error('JS FAILED:', code.slice(0, 300)); throw error; });
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      // Only the truth of the expression crosses back: a form element, for one, cannot be cloned.
      if (await js(`Boolean(${expression})`)) return;
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
    const nodes = [...document.querySelectorAll('.tool-button, .delivery-actions button, .overview-toggle, .inspector-tabs button, .commit-search, .notification-bell, .chat-compose textarea, .send-button')];
    return nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth || r.width < 20 || r.bottom > innerHeight; }).map(node => node.textContent || node.getAttribute('aria-label'));
  })()`), [], 'Primary controls fit the window');

  const assertDialog = async () => {
    assert.deepEqual(await js(`(() => {
      const dialog = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      const nodes = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(n => n.tabIndex >= 0 && n.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      const initial = dialog.contains(document.activeElement);
      last.focus(); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      const forward = document.activeElement === first;
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      const backward = document.activeElement === last;
      const background = document.querySelector('.topbar');
      const inert = Boolean(background?.closest('[inert]'));
      first.focus();
      return { initial, forward, backward, inert };
    })()`), { initial: true, forward: true, backward: true, inert: true });
  };

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
  await js(`(() => { const button = document.querySelector('.branch-main'); button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); })()`);
  await waitFor(`document.querySelector('[role="menu"]')`);
  assert.equal(await js(`document.activeElement.getAttribute('role')`), 'menuitem');
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(`!document.querySelector('[role="menu"]')`);
  assert.equal(await js(`document.activeElement.classList.contains('branch-main')`), true, 'Context menu restores keyboard focus');

  // The overview keeps edited, saved, integrated and published apart, and names one next step by intent.
  await waitFor(`document.querySelector('.work-overview')?.dataset.next === 'save_changes'`);
  assert.equal(await js(`document.querySelector('.overview-toggle').getAttribute('aria-expanded')`), 'false');
  assert.equal(await js(`document.querySelector('.overview-details') === null`), true, 'Details take no room by default');
  assert.ok(await js(`document.querySelector('.work-overview').getBoundingClientRect().height <= 40`), 'Default status is a single compact row');
  assert.equal(await js(`document.querySelectorAll('.repo-toolbar .primary-button').length`), 1, 'One primary work action');
  assert.match(await js(`document.querySelector('.repo-toolbar .primary-button').innerText`), /Revisar y guardar/);
  assert.match(await js(`document.querySelector('.overview-summary').innerText`), /2 archivos sin guardar[\s\S]*Solo en este equipo[\s\S]*Falta integrar en main/);
  await capture('status-strip');
  // The alternate action is keyboard accessible and Escape returns focus to its trigger.
  await js(`document.querySelector('.overview-more').click()`);
  await waitFor(`document.querySelector('.context-menu [role="menuitem"]')`);
  assert.match(await js(`document.activeElement.textContent`), /Guardar e integrar en main/);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(`!document.querySelector('.context-menu')`);
  assert.equal(await js(`document.activeElement === document.querySelector('.overview-more')`), true);
  await js(`document.querySelector('.overview-toggle').click()`);
  await waitFor(`document.querySelector('.overview-details')`);
  assert.equal(await js(`localStorage.getItem('gitcat-work-overview-details')`), 'open');
  const stage = (name) => js(`document.querySelector('.work-overview [data-stage="${name}"]').innerText`);
  assert.match(await stage('edited'), /En este equipo[\s\S]*2 archivos sin guardar/);
  assert.match(await stage('integrated'), /En main[\s\S]*Falta integrar en main: 1 commit/);
  assert.match(await stage('published'), /Sin remoto conectado/);
  const nextStep = await js(`document.querySelector('.work-overview .overview-next').innerText`);
  for (const entry of [/Siguiente paso/, /Guarda tus cambios/, /En términos de Git: git add \+ git commit/]) assert.match(nextStep, entry);
  // Naming remarks wait behind a disclosure instead of sitting on the beginner path.
  assert.equal(await js(`document.querySelectorAll('.naming-suggestion').length`), 0);
  await capture('work-overview');
  await js(`document.querySelector('.overview-toggle').click()`);
  assert.equal(await js(`localStorage.getItem('gitcat-work-overview-details')`), 'collapsed');
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
  assert.equal(await js(`document.querySelector('.overview-toggle').getAttribute('aria-expanded')`), 'false', 'Compact preference survives reload');
  await js(`document.querySelector('.overview-toggle').click()`);
  await waitFor(`document.querySelector('.overview-details')`);
  await assertFits(); await capture('compact-details');
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.overview-details')`);
  assert.equal(await js(`document.querySelector('.overview-toggle').getAttribute('aria-expanded')`), 'true', 'Details preference survives reload');
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
  await assertDialog();
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
  assert.equal(await js(`document.querySelector('.delivery-option input').checked`), false, 'Primary save does not also integrate');
  assert.equal(git('status', '--porcelain'), before, 'Opening save never changes Git');
  await js(`document.querySelector('.overview-more').click()`);
  await waitFor(`document.querySelector('.context-menu [role="menuitem"]')`);
  await js(`document.querySelector('.context-menu [role="menuitem"]').click()`);
  await waitFor(`document.querySelector('.delivery-option input').checked`);
  assert.equal(git('status', '--porcelain'), before, 'Choosing integration still waits for review');
  // Asking for one shows what would leave this Mac, file by file, before anything is sent.
  await js(`document.querySelector('.commit-form-heading button').click()`);
  await waitFor(`document.querySelector('.sharing-modal')`);
  const disclosure = await js(`document.querySelector('.sharing-modal').innerText`);
  for (const entry of [/Antes de que el asistente lea GitCat/, /OpenAI \([^,)]+, api\.openai\.com\)/, /app\.txt/, /Se envía/, /No compartir nunca de este repositorio/, /no demuestra que un repositorio sea seguro/, /No necesitas el asistente/]) assert.match(disclosure, entry);
  assert.doesNotMatch(disclosure, /new-file\.txt/, 'Only the ticked files are part of the description request');
  assert.equal(described.length, 0, 'Still nothing sent while the disclosure is open');
  await capture('sharing-disclosure');
  await assertDialog();
  await js(`document.querySelector('.sharing-modal .sharing-accept').click()`);
  await waitFor(`document.querySelector('#commit-description')?.value === 'Update menu and add a new file'`);
  assert.deepEqual(described.at(-1), ['app.txt'], 'The description reads only the ticked files');
  await js(`${rowFor('new-file.txt')}.querySelector('.change-include').click()`);
  await waitFor(`document.querySelector('.inspector .select-all')?.innerText.includes('Se guardarán 2 de 2 archivos')`);
  assert.equal(await js(`document.querySelector('.delivery-option input').checked`), true);
  assert.match(await js(`document.querySelector('.inspector .change-row[title^="Nuevo · incluido"]').innerText`), /new-file\.txt/);
  // Who the save will be signed as is said beside the form, with where that comes from.
  assert.match(await js(`document.querySelector('.commit-author-note').innerText`), /Se guarda como GitCat QA <qa@example\.test>, configurado solo para este repositorio/);
  assert.equal(await js(`Boolean(document.querySelector('.changes-view .readiness-checklist'))`), false, 'Nothing to set up, so no checklist in the way');
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
  // Saved and integrated here is still not published anywhere, and the overview says so.
  await waitFor(`document.querySelector('.work-overview')?.dataset.next === 'connect_remote'`);
  assert.match(await stage('saved'), /Solo en este equipo[\s\S]*no es una copia de seguridad hasta que se publica/);
  assert.match(await stage('integrated'), /Estás en main/);
  assert.match(await js(`document.querySelector('.work-overview .overview-next').innerText`), /Conecta un sitio donde publicar[\s\S]*git remote add/);
  assert.match(await js(`document.querySelector('.overview-summary').innerText`), /Solo en este equipo/, 'A save is described as local, never as a backup');
  // A push with nowhere to go is explained from the repository itself, with the way on, and the
  // assistant is not needed for it: no provider request is made.
  const headBeforePush = git('rev-parse', 'HEAD');
  await js(`[...document.querySelectorAll('.toolbar-tools .tool-button')].find((node) => node.innerText.trim() === 'Push').click()`);
  await waitFor(`document.querySelector('.plan-card .plan-actions .primary-button')`);
  // Before confirming, the plan says where the work would go; here there is nowhere yet, and the way on is offered.
  await waitFor(`document.querySelector('.plan-card .readiness-row[data-item="remote"]')`);
  const publishReadiness = await js(`document.querySelector('.plan-card .readiness-checklist').innerText`);
  for (const entry of [/Adónde va esto/i, /Todavía no está conectado a un remoto/, /Guardar funciona sin él/, /Conectar un remoto…/]) assert.match(publishReadiness, entry);
  assert.ok(readinessRequests.some((entry) => entry.path === snapshot.path && entry.access), 'A publish checks access before it is confirmed');
  // The plan leads with the goal; the command waits, closed, in the technical details.
  assert.match(await js(`document.querySelector('.plan-card .plan-goal').innerText`), /Proyecto[\s\S]*no está conectado a un remoto, así que no hay adónde enviar main/);
  assert.equal(await js(`document.querySelector('.plan-card .plan-technical').open`), false, 'Commands stay folded away until asked for');
  assert.match(await js(`document.querySelector('.plan-card .plan-technical').textContent`), /Comandos Git[\s\S]*git push/);
  await capture('publish-readiness');
  await js(`document.querySelector('.plan-card .plan-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.recovery-card[data-kind="no_remote"]')`);
  // The stopped push is never told as a success: its step is shown as stopped, with Git's words folded away.
  assert.match(await js(`document.querySelector('.completion-card[data-status="failed"]').innerText`), /no se completó[\s\S]*Se detuvo aquí/);
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
  // Without a provider the repository opens straight away: no setup screen stands in the way.
  await waitFor(`document.querySelector('.rebase-banner .guide-open')`);
  assert.equal(await js(`Boolean(document.querySelector('.welcome'))`), false, 'No first-run gate');
  assert.match(await js(`document.querySelector('.statusbar .provider-status').innerText`), /Asistente de IA sin conectar/);
  const banner = await js(`document.querySelector('.rebase-banner').innerText`);
  assert.match(banner, /Fusión en curso/); assert.match(banner, /3 archivos en conflicto/);
  assert.doesNotMatch(banner, /Proponer resolución/, 'No assistant, no draft button');
  // A half-finished merge outranks every other step, and the overview's button opens the same guide.
  await waitFor(`document.querySelector('.work-overview')?.dataset.next === 'finish_pending'`);
  assert.match(await js(`document.querySelector('.work-overview .overview-next').innerText`), /Termina la operación en curso[\s\S]*Fusión en curso[\s\S]*git merge --continue/);
  await js(`document.querySelector('.repo-toolbar .overview-actions .primary-button').click()`);
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
  await waitFor(`document.querySelector('.completion-card[data-status="completed"]')?.innerText.includes('Qué cambió')`);
  assert.equal(proposals, 0, 'No provider was needed at any point');
  // The assistant tab explains how to connect instead of pretending to work, and nothing is interpreted locally.
  await js(`[...document.querySelectorAll('.inspector-tabs button')][1].click()`);
  await waitFor(`document.querySelector('.assistant-setup')`);
  assert.match(await js(`document.querySelector('.assistant-setup').innerText`), /Conecta un asistente de IA para preguntar con tus propias palabras/);
  assert.equal(await js(`document.querySelector('.chat-compose textarea').disabled`), true);
  await capture('assistant-not-connected');

  // A fresh profile: nothing saved, no provider. Opening a project is the first thing offered.
  restored = { projects: [], unavailable: [], order: [] };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.welcome-card.first-run')`);
  const welcome = await js(`document.querySelector('.welcome-card').innerText`);
  for (const entry of [/Abrir un proyecto existente/, /Clonar desde una URL/, /Empezar a seguir una carpeta/, /Listo sin configurar nada/, /Guardar tus cambios/, /Resolver conflictos paso a paso/, /Asistente de IA · opcional/, /Conectar un asistente de IA/]) assert.match(welcome, entry);
  assert.doesNotMatch(welcome, /REQUERIDO|API key/i, 'No technical configuration before the first useful action');
  assert.match(await js(`document.querySelector('.welcome-card .start-option.primary').innerText`), /^Abrir un proyecto existente/);
  await capture('first-run');
  // The guided connection: what a provider is, that it is billed by the provider, where the key comes from.
  await js(`[...document.querySelectorAll('.welcome-ai button')][0].click()`);
  await waitFor(`document.querySelector('.settings-modal.guided')`);
  await assertDialog();
  win.setSize(1280, 800);
  win.webContents.setZoomFactor(1.5);
  await js(`document.querySelector('.settings-modal .modal-actions button').focus()`);
  assert.equal(await js(`(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })()`), true, 'Dialog primary actions reachable at 150% zoom on a laptop');
  await capture('settings-large-text');
  win.webContents.setZoomFactor(1);
  win.setSize(1480, 940);
  const settingsText = () => js(`document.querySelector('.settings-modal').innerText`);
  await waitFor(`document.querySelector('.settings-modal .readiness-row[data-item="author"]')`);
  const guide = await settingsText();
  // Without a project, Settings still says whether Git is ready and who saves would be signed as.
  for (const entry of [/Listo para guardar y publicar/, /Git \d[\d.]* está listo/, /Git todavía no sabe quién guarda/, /No es un inicio de sesión/]) assert.match(guide, entry);
  await js(`document.querySelector('.settings-modal .readiness-section').scrollIntoView()`);
  await capture('settings-readiness');
  await js(`document.querySelector('.settings-modal .modal-heading').scrollIntoView()`);
  for (const entry of [/Asistente de IA \(opcional\)/, /Sin conectar/, /OpenAI cobra a tu cuenta/, /GitCat no cobra nada/, /Crea una clave/, /solo para el asistente de IA/, /recomendado/, /Avanzado: ID de modelo personalizado/,
    /Tres accesos distintos/, /Clave del asistente de IA/, /Identidad de autor en Git/, /Acceso al remoto/]) assert.match(guide, entry);
  assert.equal(await js(`Boolean(document.querySelector('.settings-modal .model-custom'))`), false, 'The custom model ID is an advanced choice, hidden until picked');
  await js(`[...document.querySelectorAll('.ai-steps button')].find((node) => node.innerText.includes('claves de OpenAI')).click()`);
  for (let attempt = 0; attempt < 100 && !openedPages.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(openedPages, ['api_keys'], 'The key page is named, never passed as an address');
  // Connecting without a key asks for one; nothing is sent.
  await js(`document.querySelector('.ai-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.settings-modal .modal-error')?.innerText.includes('pega tu API key')`);
  assert.equal(connectRequests.length, 0);
  // An invalid key and an unknown custom model are explained in plain words and can be retried.
  const typeKey = (value) => js(`(() => { const input = document.querySelector('.settings-modal input[type="password"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await typeKey('sk-wrong');
  connectAnswers.push({ ok: false, kind: 'invalid_key', detail: 'El proveedor respondió 401: Incorrect API key provided: sk-wro…' });
  await js(`document.querySelector('.ai-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.ai-problem[data-kind="invalid_key"]')`);
  assert.match(await settingsText(), /No se pudo conectar/);
  assert.match(await js(`document.querySelector('.ai-problem').innerText`), /OpenAI no aceptó esta clave[\s\S]*Reintentar/);
  await js(`document.querySelector('.ai-problem').scrollIntoView({ block: 'center' })`);
  await new Promise(resolve => setTimeout(resolve, 100));
  await capture('settings-invalid-key');
  await js(`[...document.querySelectorAll('.model-option')][1].querySelector('input').click()`);
  await waitFor(`document.querySelector('.settings-modal .model-custom')`);
  await js(`(() => { const input = document.querySelector('.settings-modal .model-custom'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'gpt-imaginary'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  connectAnswers.push({ ok: false, kind: 'unknown_model' });
  await js(`document.querySelector('.ai-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.ai-problem[data-kind="unknown_model"]')`);
  assert.equal(connectRequests.at(-1).model, 'gpt-imaginary');
  await js(`[...document.querySelectorAll('.ai-problem button')].find((node) => node.innerText.includes('Usar el modelo recomendado')).click()`);
  await waitFor(`!document.querySelector('.settings-modal .model-custom')`);
  // A provider outage is the provider's problem; retrying the same attempt connects.
  connectAnswers.push({ ok: false, kind: 'outage' }, { ok: true });
  await js(`document.querySelector('.ai-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.ai-problem[data-kind="outage"]')`);
  assert.match(await js(`document.querySelector('.ai-problem').innerText`), /OpenAI tiene problemas ahora mismo[\s\S]*no tuyo/);
  await js(`[...document.querySelectorAll('.ai-problem button')].find((node) => node.innerText.includes('Reintentar')).click()`);
  await waitFor(`document.querySelector('.ai-status[data-state="connected"]')`);
  assert.equal(connectRequests.at(-1).model, 'gpt-5.6-luna');
  assert.equal(connectRequests.at(-1).hasKey, true);
  assert.equal(await js(`document.querySelector('.settings-modal input[type="password"]').value`), '', 'The key leaves the field once saved');
  await capture('settings-connected');
  await js(`document.querySelector('.settings-modal .modal-actions .ghost-button').click()`);
  await waitFor(`document.querySelector('.welcome-ai.connected')`);
  // Secure storage unavailable: the key field is closed and the reason is plain, with a retry.
  connected = false; secureStorage = false;
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.welcome-card.first-run')`);
  await js(`document.querySelector('.topbar .top-actions .icon-button').click()`);
  await waitFor(`document.querySelector('.ai-problem[data-kind="storage_unavailable"]')`);
  assert.match(await js(`document.querySelector('.ai-problem').innerText`), /nunca como texto plano/);
  assert.equal(await js(`document.querySelector('.settings-modal input[type="password"]').disabled`), true);
  await js(`document.querySelector('.ai-problem').scrollIntoView({ block: 'center' })`);
  await new Promise(resolve => setTimeout(resolve, 100));
  await capture('settings-storage-unavailable');

  // Starting from an ordinary folder: three plain ways in, a preview of what tracking does, and
  // nothing written until it is confirmed. The files then wait as changes for the first save.
  secureStorage = true;
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelectorAll('.welcome-card .start-option').length === 3`);
  const options = await js(`[...document.querySelectorAll('.welcome-card .start-option')].map((node) => node.innerText)`);
  assert.match(options[0], /Abrir un proyecto existente[\s\S]*ya usa Git/);
  assert.match(options[1], /Clonar desde una URL[\s\S]*Solo necesitas su dirección/);
  assert.match(options[2], /Empezar a seguir una carpeta[\s\S]*No se sube nada/);
  assert.equal(await js(`document.querySelector('.welcome-card .start-option.primary').dataset.option`), 'open');
  const setText = (selector, value) => js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const plain = path.join(setupRoot, 'Recetas');
  fs.mkdirSync(path.join(plain, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'pan.md'), 'harina\n');
  fs.writeFileSync(path.join(plain, 'tarta.md'), 'azúcar\n');
  fs.writeFileSync(path.join(plain, '.env'), 'TOKEN=abc\n');
  fs.writeFileSync(path.join(plain, 'node_modules', 'pkg', 'index.js'), '1\n');
  nextFolder = plain;
  // Opening it as a project explains that it is not one yet instead of failing with Git's words.
  await js(`document.querySelector('.welcome-card .start-option[data-option="open"]').click()`);
  await waitFor(`document.querySelector('.setup-modal')?.innerText.includes('todavía no es un proyecto de Git')`);
  assert.match(await js(`document.querySelector('.setup-modal').innerText`), /puede empezar a seguirla aquí mismo/);
  await js(`document.querySelector('.setup-modal .ghost-button').click()`);
  await waitFor(`!document.querySelector('.setup-modal')`);
  await js(`document.querySelector('.welcome-card .start-option[data-option="track"]').click()`);
  await waitFor(`document.querySelector('.setup-modal .setup-facts')`);
  const trackText = await js(`document.querySelector('.setup-modal').innerText`);
  for (const entry of [/Empezar a seguir Recetas/, /4 archivos aparecerán como cambios, listos para tu primer guardado/, /No se sube nada/, /no se cambian, no se mueven/, /carpeta oculta \.git/, /La primera rama se llamará \S+/, /Lo que se suele dejar fuera/, /GitCat no escribe un \.gitignore por ti/]) assert.match(trackText, entry);
  assert.deepEqual((await js(`document.querySelector('.setup-gitignore').innerText`)).split('\n').sort(), ['.env', 'node_modules/']);
  assert.equal(fs.existsSync(path.join(plain, '.git')), false, 'Previewing writes nothing');
  await capture('start-tracking-preview');
  await js(`[...document.querySelectorAll('.setup-modal .primary-button')].find((node) => node.innerText.includes('Empezar a seguir')).click()`);
  await waitFor(`!document.querySelector('.setup-modal') && document.querySelector('.changes-view')`);
  assert.equal(fs.existsSync(path.join(plain, '.git')), true);
  assert.equal(fs.existsSync(path.join(plain, '.gitignore')), false, 'The .gitignore suggestion is never written on its own');
  await waitFor(`document.querySelector('.graph-empty.first-save')`);
  assert.match(await js(`document.querySelector('.graph-empty.first-save').innerText`), /Todavía no hay versiones guardadas[\s\S]*listos para el primer guardado/);
  assert.match(await js(`document.querySelector('.changes-view').innerText`), /primera versión guardada del proyecto/);
  for (const file of ['pan.md', 'tarta.md', '.env']) assert.ok((await js(`document.querySelector('.changes-view').innerText`)).includes(file), `${file} waits for the first save`);
  await capture('first-save-ready');
  // Before the first save, the checklist says Git is ready and that nobody is set as the author yet,
  // with the way to set one. The name, the email and where they apply are reviewed before anything is written.
  await waitFor(`document.querySelector('.changes-view .readiness-row[data-item="author"][data-state="missing"]')`);
  const firstSaveChecklist = await js(`document.querySelector('.changes-view .readiness-checklist').innerText`);
  for (const entry of [/Antes de tu primer guardado/i, /Git \d[\d.]* está listo/, /Git todavía no sabe quién guarda/, /Poner nombre y correo…/]) assert.match(firstSaveChecklist, entry);
  await capture('first-save-checklist');
  await js(`[...document.querySelectorAll('.changes-view .readiness-actions button')].find((node) => node.innerText.includes('Poner nombre y correo')).click()`);
  await waitFor(`document.querySelectorAll('.identity-modal .identity-scope').length === 2`);
  const identityText = await js(`document.querySelector('.identity-modal').innerText`);
  for (const entry of [/Solo este repositorio/, /Todos los repositorios de este Mac/, /Ahora: sin configurar/, /no es un inicio de sesión/]) assert.match(identityText, entry);
  assert.equal(await js(`document.querySelector('.identity-scope[data-scope="local"] input').checked`), true, 'This repository only is the default');
  await setText('.identity-modal label:nth-of-type(1) input', 'QA Recetas');
  await setText('.identity-modal label:nth-of-type(2) input', 'recetas@example.test');
  await js(`document.querySelector('.identity-scope[data-scope="global"] input').click()`);
  await waitFor(`document.querySelector('.identity-scope[data-scope="global"] input').checked`);
  await capture('identity-review');
  await js(`document.querySelector('.identity-modal .primary-button').click()`);
  await waitFor(`document.querySelector('.plan-card .plan-actions .primary-button')`);
  const identityPlan = await js(`document.querySelector('.plan-card').textContent`);
  for (const entry of [/todos los repositorios de este Mac como QA Recetas <recetas@example\.test>/, /Todavía no hay una identidad global/, /conservan su autor/, /git config --global user\.name/]) assert.match(identityPlan, entry);
  assert.equal(fs.readFileSync(globalGitConfig, 'utf8'), '', 'Nothing is written before the confirmation');
  await js(`document.querySelector('.plan-card .plan-actions .primary-button').click()`);
  for (let attempt = 0; attempt < 100 && !fs.readFileSync(globalGitConfig, 'utf8').includes('recetas@example.test'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(fs.readFileSync(globalGitConfig, 'utf8'), /name = QA Recetas[\s\S]*email = recetas@example\.test/);
  assert.throws(() => execFileSync('git', ['config', '--local', 'user.name'], { cwd: plain, stdio: 'ignore' }), 'The global choice leaves the repository settings alone');
  await js(`document.querySelector('.inspector-tabs button').click()`);
  await waitFor(`document.querySelector('.changes-view .readiness-row[data-item="author"][data-state="ok"]')`);
  assert.match(await js(`document.querySelector('.changes-view .readiness-row[data-item="author"]').innerText`), /QA Recetas <recetas@example\.test>[\s\S]*configurado para todos los repositorios de este Mac/);
  await capture('first-save-author-set');

  // Cloning: the address is checked while it is typed, the destination is previewed, a folder with
  // files is refused, and a stopped copy leaves the chosen place exactly as it was.
  cloneParent = path.join(setupRoot, 'Proyectos');
  fs.mkdirSync(path.join(cloneParent, 'ocupada'), { recursive: true });
  fs.writeFileSync(path.join(cloneParent, 'ocupada', 'mio.txt'), 'mío\n');
  const sockets = new Set();
  const silent = require('node:net').createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  await js(`document.querySelector('.tab-add').click()`);
  await waitFor(`document.querySelectorAll('.setup-modal .start-option').length === 3`);
  await js(`document.querySelector('.setup-modal .start-option[data-option="clone"]').click()`);
  await waitFor(`document.querySelector('.clone-form')`);
  for (const [address, problem] of [['file:///etc', 'local'], ['ext::sh -c touch', 'spaces'], ['ext::sh', 'transport_helper'], ['--upload-pack=touch', 'option'], ['http://github.com/o/r.git', 'insecure'], ['https://user:token@github.com/o/r.git', 'credentials']]) {
    await setText('.clone-form input', address);
    await waitFor(`document.querySelector('.clone-form .setup-problem')?.dataset.problem === ${JSON.stringify(problem)}`);
  }
  assert.match(await js(`document.querySelector('.clone-form .setup-problem').innerText`), /contraseña o un token/);
  assert.equal(await js(`document.querySelector('.clone-form .primary-button').disabled`), true, 'Nothing can start from an address that failed the check');
  await setText('.clone-form input', `https://127.0.0.1:${silent.address().port}/octo/demo.git`);
  await waitFor(`document.querySelectorAll('.clone-form input')[1].value === 'demo'`);
  await js(`document.querySelector('.setup-parent button').click()`);
  await waitFor(`document.querySelector('.setup-preview')`);
  assert.match(await js(`document.querySelector('.setup-preview').innerText`), new RegExp(`La copia se creará en[\\s\\S]*Proyectos/demo[\\s\\S]*No se toca nada más`));
  await setText('.clone-form label:nth-of-type(2) input', 'ocupada');
  await waitFor(`document.querySelector('.clone-form .setup-problem')?.dataset.problem === 'destination_not_empty'`);
  assert.match(await js(`document.querySelector('.clone-form .setup-problem').innerText`), /nunca mezcla una copia con archivos que ya existen/);
  await setText('.clone-form label:nth-of-type(2) input', 'demo');
  await waitFor(`document.querySelector('.setup-preview') && !document.querySelector('.clone-form .primary-button').disabled`);
  await js(`document.querySelector('.clone-form .primary-button').click()`);
  await waitFor(`document.querySelector('.setup-running')`);
  for (let attempt = 0; attempt < 100 && !sockets.size; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fs.readdirSync(cloneParent).some((name) => name.startsWith('.demo.gitcat-clone-')), 'The copy in progress has a folder of its own');
  await capture('clone-running');
  await js(`[...document.querySelectorAll('.clone-form .modal-actions button')].find((node) => node.innerText.includes('Cancelar la copia')).click()`);
  await waitFor(`document.querySelector('.clone-form .setup-notice')?.innerText.includes('La copia se detuvo')`);
  assert.deepEqual(fs.readdirSync(cloneParent), ['ocupada'], 'Only the folder the copy created was removed');
  assert.deepEqual(fs.readdirSync(path.join(cloneParent, 'ocupada')), ['mio.txt']);
  for (const socket of sockets) socket.destroy();
  silent.close();

  // An empty repository clones cleanly and opens on the way to its first save.
  execFileSync('git', ['init', '-q', '--bare', emptyRemote]);
  await setText('.clone-form input', emptyRemoteUrl);
  // The name was edited by hand above, so it stays the person's until they change it again.
  assert.equal(await js(`document.querySelectorAll('.clone-form input')[1].value`), 'demo');
  await setText('.clone-form label:nth-of-type(2) input', 'empty-start');
  await waitFor(`document.querySelectorAll('.clone-form input')[1].value === 'empty-start' && document.querySelector('.setup-preview')`);
  await js(`document.querySelector('.clone-form .primary-button').click()`);
  await waitFor(`!document.querySelector('.setup-modal') && document.querySelector('.graph-empty.first-save')`);
  assert.match(await js(`document.querySelector('.graph-empty.first-save').innerText`), /Este proyecto está vacío[\s\S]*empty-start/);
  assert.match(await js(`document.querySelector('.changes-view').innerText`), /Todavía no hay versiones guardadas/);
  assert.match(await js(`document.querySelector('.window-tab.active').innerText`), /empty-start/);
  assert.match(await js(`document.querySelector('.branch-list').innerText`), /está lista\. Aparecerá aquí después del primer guardado/, 'An unborn branch is explained, not reported as a filter miss');
  assert.doesNotMatch(await js(`document.querySelector('.toolbar-delivery').innerText`), /Guardado en este equipo/, 'Nothing is called saved before the first save');
  // An empty clone has a remote but nothing to publish, and nothing is claimed about it.
  await waitFor(`document.querySelector('.work-overview')?.dataset.next === 'add_first_files'`);
  assert.match(await js(`document.querySelector('.work-overview [data-stage="saved"]').innerText`), /Aún no hay guardados/);
  assert.match(await js(`document.querySelector('.work-overview [data-stage="published"]').innerText`), /Publicado en origin[\s\S]*Aún no hay nada que publicar/);
  await capture('cloned-empty');
  // With a remote, Settings says where a publish goes and checks access read-only; this one is a
  // folder on this Mac, so nothing reaches a network.
  await js(`document.querySelector('.top-actions .icon-button').click()`);
  await waitFor(`document.querySelector('.settings-modal .readiness-access[data-access="ok"]')`);
  const remoteReadiness = await js(`document.querySelector('.settings-modal .readiness-row[data-item="remote"]').innerText`);
  for (const entry of [/Se publica en \S*empty-remote\.git/, /origin · una carpeta de este Mac · el destino que esta rama ya sigue|origin · una carpeta de este Mac · el habitual, origin/, /Acceso confirmado/, /Comprobar el acceso de nuevo/]) assert.match(remoteReadiness, entry);
  assert.match(await js(`document.querySelector('.settings-modal .readiness-row[data-item="author"]').innerText`), /QA Recetas <recetas@example\.test>[\s\S]*configurado para todos los repositorios de este Mac/);
  await js(`document.querySelector('.settings-modal .readiness-section').scrollIntoView()`);
  await capture('settings-readiness-remote');
  win.destroy();
  console.log('PASS: unavailable saved project kept with retry, graph with work in progress, commit details, context menus, collapsible branch panel, compact layout, stable notifications, a work overview separating edited, saved, integrated and published work with one next step, readiness before a publish and the first save (Git, author, remote), a reviewed global identity written only to an isolated config, per-file include/exclude with selected diff and description, previewed .gitignore rule, AI sharing disclosure before the first description, reviewed save and integration, failed push recovered without the assistant, double-click checkout, background refresh, local secret warning, guided conflict resolution without an assistant, fresh profile opening straight to projects with a guided AI connection (invalid key, unknown model, outage retry, unavailable secure storage), three ways to start with a start-tracking preview and first-save guidance, clone address checks, occupied destination, cancelled clone cleanup, and an empty cloned repository.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
