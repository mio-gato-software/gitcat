// Renderer smoke test using an isolated, disposable Git repository and profile.
// Run with npm run test:ui; no personal repository, settings or API key is used.
const electron = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
// Chromium locks profile files on Windows until the process has exited.
if (typeof electron === 'string') {
  // Match Git's canonical paths, including Windows 8.3 aliases and macOS /var.
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gitcat-design-')));
  const result = spawnSync(electron, [__filename], {
    env: { ...process.env, GITCAT_UI_SCRATCH: scratch }, windowsHide: true, stdio: 'inherit', timeout: 900_000
  });
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const scratch = process.env.GITCAT_UI_SCRATCH;
if (!scratch) throw new Error('Run this check through Node to isolate and clean up its profile.');
const deadline = setTimeout(() => { console.error('UI check timed out'); app.exit(1); }, 890_000);
const repo = path.join(scratch, 'GitCat');
const screenshots = process.env.GITCAT_UI_SCREENSHOTS;
fs.mkdirSync(repo);
app.setPath('userData', path.join(scratch, 'profile'));
// Git reads a disposable global configuration and no system one, so this computer's own identity and
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

  const linkedWorktree = path.join(scratch, 'Linked worktree');
  const detachedWorktree = path.join(scratch, 'Detached worktree');
  git('worktree', 'add', '-b', 'qa/worktree', linkedWorktree);
  git('worktree', 'add', '--detach', detachedWorktree);
  fs.writeFileSync(path.join(linkedWorktree, 'worktree-only.txt'), 'separate edits');
  const service = await import(pathToFileURL(path.join(root, 'dist-electron/electron/git-service.js')));
  const { createPlanHandlers } = await import(pathToFileURL(path.join(root, 'dist-electron/electron/plan-handlers.js')));
  const planHandlers = createPlanHandlers({
    assertTrustedSender: event => assert.equal(event.senderFrame?.url, pathToFileURL(path.join(root, 'dist/index.html')).href),
    assertOpenedRepository: repoPath => {
      assert.equal(typeof repoPath, 'string');
      assert.ok(path.resolve(repoPath).startsWith(scratch + path.sep), 'Only disposable repositories are available to the fixture');
      return path.resolve(repoPath);
    },
    tracked: (_event, _path, _phase, task) => task()
  });
  planHandlers.register(ipcMain);
  ipcMain.handle('worktree:open', (_, source, target, locale) => service.openWorktree(source, target, locale));
  const snapshot = await service.getSnapshot(repo);
  const { nativeFixture } = await import(pathToFileURL(path.join(root, 'test/helpers/native-hosting-fixture.mjs')));
  const nativeUi = Object.fromEntries(['bitbucket','bitbucket_dc','azure'].map(provider=>[provider,nativeFixture(provider)]));
  const hostingAccounts = Object.values(nativeUi).map(value=>({id:`ui-${value.provider}`,provider:value.provider,baseUrl:value.baseUrl,username:value.username,accountId:value.accountId,label:value.label}));
  const hostingConnectRequests=[];
  ipcMain.handle('hosting:list',()=>({secureStorage:true,connections:hostingAccounts}));
  ipcMain.handle('hosting:connect',(_,input)=>{hostingConnectRequests.push({provider:input.provider,baseUrl:input.baseUrl,username:input.username,hasToken:Boolean(input.token)});return {secureStorage:true,connections:hostingAccounts};});
  ipcMain.handle('hosting:remove',()=>({secureStorage:true,connections:hostingAccounts}));
  let hostingScenario = false;
  const hostingSnapshot = value => hostingScenario ? { ...value, remotes: ['origin'], remoteUrls: { origin: nativeUi[hostingScenario]?.remote??'https://code.company.test/org/team/repo.git' } } : value;
  const reviewRequests = [], reviewLinks = [], reviewDrafts = [];
  let reviewPublished = false;
  const reviewUrl = 'https://code.company.test/org/team/repo/-/merge_requests/1';
  const reviewCheckedAt = '2026-11-19T23:40:00.000Z';
  let reviewScenario;
  ipcMain.handle('review:preview', (_, p, request) => {
    reviewRequests.push(request);
    const native=nativeUi[request.provider];
    if(native)return {id:'hosting-ui',repoPath:p,provider:request.provider,host:new URL(native.baseUrl).host,request,repository:native.location.repository,remoteUrl:native.remote,account:native.accountId,hosting:{connectionId:`ui-${request.provider}`,location:native.location,accountId:native.accountId,label:native.label},headHash:snapshot.head,baseHash:'b'.repeat(40),commits:[{hash:snapshot.head,subject:'Saved work for review'}],reviewable:true,checkedAt:new Date().toISOString()};
    const commits = reviewScenario?.noCommits ? [] : [{ hash: snapshot.head, subject: 'Saved work for review' }];
    const existing = reviewScenario?.open ? { url: reviewUrl, state: 'OPEN', head: request.head, base: request.base } : undefined;
    return { id: 'hosting-ui', repoPath: p, provider: request.provider, host: 'code.company.test', request, repository: 'org/team/repo', remoteUrl: 'https://code.company.test/org/team/repo.git', account: 'anna.work', headHash: snapshot.head, baseHash: 'b'.repeat(40), commits, existing, reviewable: true, checkedAt: reviewCheckedAt };
  });
  ipcMain.handle('review:publish', async (_, p, id, draft) => {
    assert.equal(id, 'hosting-ui');reviewPublished = true;
    reviewDrafts.push(draft);
    const native=nativeUi[hostingScenario];
    const pullRequest = { url: native?`${native.location.webUrl}/${native.provider==='azure'?'pullrequest':'pull-requests'}/1`:reviewUrl, state: 'OPEN' };
    return native
      ? { snapshot: hostingSnapshot(await service.getSnapshot(p)), pullRequest, warnings: [] }
      : { pullRequest, warnings: ['history_write', 'snapshot_read'] };
  });
  ipcMain.handle('review:open', (_, url) => { reviewLinks.push(url); });
  ipcMain.handle('operation:list', () => []);
  ipcMain.handle('operation:cancel', () => false);
  ipcMain.handle('repo:fetch', async (_, p) => hostingSnapshot(await service.fetchRemotes(p)));
  ipcMain.handle('switch-work:read', (_, p, target) => service.getSwitchWork(p,target));
  ipcMain.handle('switch-work:prepare', async (_, p, request, locale) => planHandlers.rememberPlan(await service.prepareSwitchWork(p, request, locale)));
  ipcMain.handle('activity:list', (_, p) => service.getActivityHistory(p));
  const recoveryChecks = [];
  ipcMain.handle('activity:suggest-recovery', (_, p, id, locale) => {
    recoveryChecks.push(id);
    return service.suggestHistoryRecovery(p, id, locale);
  });
  ipcMain.handle('activity:recover', async (_, p, id, mode, locale) => planHandlers.rememberPlan(await service.prepareHistoryRecovery(p, id, mode, locale)));
  ipcMain.handle('commit:prepare-revert', async (_, p, commit, locale) => planHandlers.rememberPlan(await service.prepareRevertCommit(p, commit, locale)));
  ipcMain.handle('activity:repair', () => service.repairActivityHistory());
  ipcMain.handle('activity:retention', (_, days) => service.setActivityRetention(days));
  ipcMain.handle('activity:clear', (_, p) => service.clearActivityHistory(p));
  ipcMain.handle('practice:info',(_,p)=>service.getPracticeInfo(p));
  ipcMain.handle('practice:create',()=>service.createPractice());
  ipcMain.handle('practice:lesson',(_,p,lesson)=>service.setPracticeLesson(p,lesson));
  ipcMain.handle('practice:edit',(_,p)=>service.editPractice(p));
  ipcMain.handle('practice:remove',(_,p)=>service.removePractice(p));
  let refreshError = false;
  // A second saved project whose folder is gone: it must stay listed and explain itself instead of vanishing.
  const movedPath = path.join(scratch, 'Moved project');
  const moved = () => ({ path: movedPath, name: 'Moved project', reason: 'missing', detail: `ENOENT: ${movedPath}`, checkedAt: new Date().toISOString() });
  let retries = 0;
  // The last scenario swaps in a repository stopped in a merge, with no assistant configured.
  let restored = null;
  let savedWorkspace;
  let configured = true;
  ipcMain.handle('workspace:restore', () => restored ?? ({ projects: [snapshot], unavailable: [moved()], order: [snapshot.path, movedPath], activePath: snapshot.path }));
  ipcMain.handle('workspace:retry', () => { retries += 1; return { unavailable: moved() }; });
  ipcMain.handle('workspace:save', (_, paths, activePath) => { savedWorkspace = { paths, activePath }; });
  // The fresh-profile scenario drives the guided connection against scripted answers; nothing reaches a provider.
  let secureStorage = true;
  let connected = false;
  const connectAnswers = [];
  const connectRequests = [];
  const openedPages = [];
  const llmConfig = () => ({ provider: 'openai', model: configured ? 'ui-test' : 'gpt-6-luna', configured: configured || connected, secureStorage });
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
  const snapshotReads = new Map();
  ipcMain.handle('repo:snapshot', async (_, p) => {
    if (refreshError) throw new Error('A long example error for notification layout. '.repeat(30));
    const request = Symbol();
    const started = Date.now();
    snapshotReads.set(request, started);
    try { return hostingSnapshot(await service.getSnapshot(p || repo)); }
    finally {
      snapshotReads.delete(request);
      const elapsed = Date.now() - started;
      if (process.env.GITCAT_UI_DEBUG && elapsed > 5000) console.error(`Snapshot read took ${elapsed}ms`);
    }
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
  const descriptionGates = new Map();
  ipcMain.handle('commit:generate-description', async (_, p, locale, paths) => {
    const current = await service.getSnapshot(p);
    described.push([...paths].sort());
    const gate = descriptionGates.get(p);
    const description = gate ? await gate : 'Update menu and add a new file';
    return { description, stateId: current.stateId, selection: current.changes.filter((change) => paths.includes(change.path)).map((change) => ({ path: change.path, version: change.version })) };
  });
  ipcMain.handle('commit:selection-diff', (_, p, paths, locale) => service.getSelectionDiff(p, paths, locale));
  // Sharing decisions are the real service's, kept in this disposable profile.
  ipcMain.handle('sharing:get', (_, p, purpose, paths, locale) => service.getAiSharing(p, purpose, paths, locale));
  ipcMain.handle('sharing:acknowledge', (_, p, scope) => service.acknowledgeAiSharing(p, scope));
  ipcMain.handle('sharing:set-exclusions', (_, p, exclusions, locale) => service.setAiSharingExclusions(p, exclusions, locale));
  ipcMain.handle('sharing:review', (_, p, file, share, locale) => service.setAiSharingReview(p, file, share, locale));
  let recoverCalls = 0;
  ipcMain.handle('action:describe-failure', (_, p, failure) => service.describeFailure(p, failure, planHandlers.getFailure(failure.planId)));
  ipcMain.handle('action:recover', (_, p, failure, context, locale) => { recoverCalls += 1; return service.planRecovery(p, failure, context, locale); });
  ipcMain.handle('action:prepare-retry', async (_, p, id, locale) => {
    return planHandlers.rememberPlan(await service.prepareRetry(p, planHandlers.getFailure(id), locale));
  });
  ipcMain.handle('action:prepare', async (_, p, operation, args, locale) => {
    return planHandlers.rememberPlan(await service.prepareOperation(p, operation, args, locale));
  });
  const assistantRequests = [];
  ipcMain.handle('action:plan', async (_, p, question, _context, locale, includeWorkingChanges = false) => {
    assistantRequests.push({ question, includeWorkingChanges });
    const current = await service.getSnapshot(p);
    const base = await service.prepareOperation(p, 'status', {}, locale);
    if (question === 'Explica los cambios sin guardar' && !includeWorkingChanges) {
      return { ...base, kind: 'question', allowed: false, steps: [], workingChangesRequired: true,
        summary: 'Incluir cambios sin guardar', rationale: 'Necesito leer los cambios para explicarlos.' };
    }
    return { ...base, kind: 'question', steps: [], answer: 'El último merge integró el buscador.',
      answerCommit: current.commits.find((commit) => commit.parents.length > 1) };
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

  // Hosted Macs may have a small display; still exercise the requested desktop sizes.
  const win = new BrowserWindow({ width: 1480, height: 940, show: false, enableLargerThanScreen: true, webPreferences: { backgroundThrottling: false, preload: path.join(root, 'electron/preload.cjs') } });
  const { syncMacFullscreen } = await import(pathToFileURL(path.join(root, 'dist-electron/electron/window-chrome.js')));
  syncMacFullscreen(win);
  const js = code => win.webContents.executeJavaScript(code).catch((error) => { if (process.env.GITCAT_UI_DEBUG) console.error('JS FAILED:', code.slice(0, 300)); throw error; });
  // A snapshot starts many Git processes in sequence. Hosted Windows runners can
  // take more than 20 seconds for a read; keep each wait bounded by a minute.
  const waitFor = async (expression, timeoutMs = 60_000) => {
    for (let attempt = 0; attempt < Math.ceil(timeoutMs / 50); attempt++) {
      // Only the truth of the expression crosses back: a form element, for one, cannot be cloned.
      if (await js(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (process.env.GITCAT_UI_DEBUG) {
      console.error((await js(`document.body.innerText`)).slice(0, 3000));
      console.error('Fixture Git status:', git('status', '--porcelain'));
      console.error('Pending snapshot ages (ms):', [...snapshotReads.values()].map(started => Date.now() - started));
    }
    throw new Error(`UI did not become ready: ${expression}`);
  };
  const refreshStatus = () => js(`document.querySelector('.repo-toolbar [data-action="refresh"]').click()`);
  const toolbarMenu = '.repo-toolbar .context-menu';
  const toolbarItem = action => `document.querySelector('${toolbarMenu} [data-action="${action}"]')`;
  const openToolbarMenu = async () => {
    await js(`if (!document.querySelector('${toolbarMenu}')) document.querySelector('.toolbar-more').click()`);
    await waitFor(`document.querySelector('${toolbarMenu}')`);
  };
  const clickToolbarItem = async action => {
    await openToolbarMenu();
    await js(`${toolbarItem(action)}.click()`);
  };
  const closeToolbarMenu = () => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const clickPull = async () => {
    const next = await js(`document.querySelector('.work-overview').dataset.next`);
    if (next === 'get_latest' || next === 'combine_diverged') {
      await js(`document.querySelector('.repo-toolbar .primary-button').click()`);
    } else {
      await clickToolbarItem('pull');
    }
  };
  // Native frame sizes and zoom updates are asynchronous on Windows. Verify the
  // content viewport before asserting a layout, just like the welcome checks.
  const resizeContent = async (width, height, zoom = 1) => {
    if (win.isMaximized()) win.unmaximize();
    if (win.isMinimized()) win.restore();
    win.webContents.setZoomFactor(zoom);
    win.setContentSize(width, height);
    const expected = Math.round(width / zoom);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await js(`innerWidth === ${expected}`)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
      // A queued Windows restore or zoom event can supersede the first resize.
      if (attempt % 10 === 9) win.setContentSize(width, height);
    }
    throw new Error(`Viewport resize failed: ${JSON.stringify({ expected, content: win.getContentSize(), bounds: win.getBounds(), maximized: win.isMaximized(), zoom: win.webContents.getZoomFactor(), renderer: await js('({width:innerWidth,height:innerHeight,ratio:devicePixelRatio})') })}`);
  };
  const capture = async name => {
    if (!screenshots) return;
    fs.mkdirSync(screenshots, { recursive: true });
    fs.writeFileSync(path.join(screenshots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const assertFits = async () => assert.deepEqual(await js(`(() => {
    const nodes = [...document.querySelectorAll('.tool-button, .toolbar-delivery button, .delivery-actions button, .overview-toggle, .inspector-tabs button, .commit-search, .notification-bell, .chat-compose textarea, .send-button')];
    return nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth || r.width < 20 || r.bottom > innerHeight; }).map(node => node.textContent || node.getAttribute('aria-label'));
  })()`), [], 'Primary controls fit the window');

  const assertTitlebarDragging = async () => assert.deepEqual(await js(`(() => {
    const header = document.querySelector('.topbar');
    const strip = document.querySelector('.window-tabs').getBoundingClientRect();
    const tabs = [...document.querySelectorAll('.window-tab')];
    const controls = [...header.querySelectorAll('button, .window-tab')];
    const blocked = controls.filter(node => getComputedStyle(node).webkitAppRegion !== 'no-drag');
    const canDragAt = (x, y) => {
      let drag = false;
      for (let node = document.elementFromPoint(x, y); node; node = node.parentElement) {
        const region = getComputedStyle(node).webkitAppRegion;
        if (region === 'no-drag') return false;
        if (region === 'drag') drag = true;
      }
      return drag;
    };
    // Even a full strip leaves a continuous grip above the reorderable tabs.
    const tabTop = Math.min(...tabs.map(node => node.getBoundingClientRect().top));
    const gripY = strip.top + 6;
    const grip = tabTop - strip.top >= 12 &&
      Array.from({ length: 20 }, (_, i) => strip.left + 2 + (strip.width - 4) * i / 19)
        .every(x => canDragAt(x, gripY));
    // With only a few projects, the large unused part of the title bar also moves the window.
    const last = tabs.at(-1).getBoundingClientRect();
    const empty = last.right >= strip.right - 8 || canDragAt((last.right + strip.right) / 2, strip.top + strip.height / 2);
    return { grip, empty, controls: blocked.map(node => node.className) };
  })()`), { grip: true, empty: true, controls: [] }, 'Title bar gaps move the window; project tabs and buttons remain interactive');

  const assertDialog = async () => {
    assert.deepEqual(await js(`(() => {
      const dialog = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])';
      const nodes = [...dialog.querySelectorAll(focusable)].filter(n => {
        const closed = n.closest('details:not([open])');
        return n.tabIndex >= 0 && n.getClientRects().length && (!closed || closed.querySelector(':scope > summary')?.contains(n));
      });
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
  // macOS can clamp the constructor size to its virtual screen before the
  // larger-than-screen option takes effect. Resize explicitly after creation.
  win.setContentSize(1480, 940);
  await waitFor('innerWidth === 1480');
  await js(`localStorage.setItem('gitcat-locale', 'es')`);
  await waitFor(`document.querySelectorAll('.window-tab').length === 2`);
  await assertTitlebarDragging();
  assert.equal(await js(`document.querySelectorAll('.tab-scroll').length`), 0, 'No overflow controls when every project fits');
  // Dragging reorders available and unavailable tabs without changing the selected project.
  const tabNames = () => js(`[...document.querySelectorAll('.window-tab [role="tab"] span')].map(node => node.textContent)`);
  const startTabDrag = (selector) => js(`(() => {
    window.tabTransfer = new DataTransfer();
    document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.tabTransfer }));
  })()`);
  const overTab = (selector, side, type = 'dragover') => js(`(() => {
    const tab = document.querySelector(${JSON.stringify(selector)}), r = tab.getBoundingClientRect();
    tab.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer: window.tabTransfer,
      clientX: ${side === 'before' ? 'r.left + 2' : 'r.right - 2'}, clientY: r.top + r.height / 2 }));
  })()`);
  await startTabDrag('.window-tab.unavailable [role="tab"]');
  await overTab('.window-tab:not(.unavailable)', 'before');
  await waitFor(`document.querySelector('.window-tab.drop-before')`);
  await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await capture('tab-reorder');
  await overTab('.window-tab:not(.unavailable)', 'before', 'drop');
  await waitFor(`document.querySelector('.window-tab:first-child.unavailable')`);
  assert.deepEqual(await tabNames(), ['Moved project', 'GitCat']);
  assert.deepEqual(savedWorkspace, { paths: [movedPath, repo], activePath: repo });
  assert.equal(await js(`document.querySelector('.window-tab.active [role="tab"] span').textContent`), 'GitCat');
  assert.equal(await js(`document.querySelectorAll('.drop-before, .drop-after, .dragging').length`), 0);
  restored = { projects: [snapshot], unavailable: [moved()], order: savedWorkspace.paths, activePath: savedWorkspace.activePath };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.window-tab:first-child.unavailable')`);
  assert.deepEqual(await tabNames(), ['Moved project', 'GitCat'], 'Saved tab order survives workspace restoration');
  // An abandoned drag and a drop from outside GitCat cannot change the workspace.
  await startTabDrag('.window-tab.unavailable [role="tab"]');
  await overTab('.window-tab:not(.unavailable)', 'after');
  await js(`document.querySelector('.window-tab.unavailable [role="tab"]').dispatchEvent(new DragEvent('dragend', { bubbles: true }))`);
  await overTab('.window-tab:not(.unavailable)', 'after', 'drop');
  assert.deepEqual(await tabNames(), ['Moved project', 'GitCat']);
  // Move right, then exercise the keyboard alternative and normal close controls.
  await startTabDrag('.window-tab.unavailable [role="tab"]');
  await overTab('.window-tab:not(.unavailable)', 'after', 'drop');
  await waitFor(`document.querySelector('.window-tab:last-of-type.unavailable')`);
  await js(`document.querySelector('.window-tab.unavailable [role="tab"]').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true, key: 'ArrowLeft' }))`);
  await waitFor(`document.querySelector('.window-tab:first-child.unavailable')`);
  await js(`document.querySelector('.window-tab.unavailable [role="tab"]').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true, key: 'ArrowRight' }))`);
  await waitFor(`document.querySelector('.window-tab:last-of-type.unavailable')`);
  await js(`document.querySelector('.window-tab.unavailable .tab-close').click()`);
  await waitFor(`document.querySelectorAll('.window-tab').length === 1`);
  assert.equal(await js(`document.querySelector('.window-tab.active [role="tab"] span').textContent`), 'GitCat');
  // Overflowing tabs remain reachable and a drop beyond the last tab moves to the end.
  const missingTabs = Array.from({ length: 12 }, (_, index) => ({ ...moved(), path: path.join(scratch, `missing-${index}`), name: `Saved project ${index}` }));
  restored = { projects: [snapshot], unavailable: missingTabs, order: [repo, ...missingTabs.map(tab => tab.path)], activePath: repo };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelectorAll('.window-tab').length === 13`);
  assert.equal(await js(`document.querySelector('.window-tabs').scrollWidth > document.querySelector('.window-tabs').clientWidth`), true);
  await waitFor(`document.querySelectorAll('.tab-scroll').length === 2`);
  assert.deepEqual(await js(`[...document.querySelectorAll('.tab-scroll')].map(button => button.disabled)`), [true, false]);
  const activeTabVisible = `(() => {
    const tab = document.querySelector('.window-tab.active').getBoundingClientRect();
    const strip = document.querySelector('.window-tabs').getBoundingClientRect();
    return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
  })()`;
  const addButtonVisible = `(() => {
    const add = document.querySelector('.tab-add').getBoundingClientRect();
    const strip = document.querySelector('.window-tabs').getBoundingClientRect();
    const actions = document.querySelector('.top-actions').getBoundingClientRect();
    return add.left >= strip.right && add.right <= actions.left;
  })()`;
  await capture('tabs-overflow-start');
  await js(`document.querySelectorAll('.tab-scroll')[1].click()`);
  await waitFor(`document.querySelector('.window-tabs').scrollLeft > document.querySelector('.window-tabs').clientWidth * .6`);
  assert.equal(savedWorkspace.activePath, repo, 'Browsing hidden tabs does not switch the selected project');
  await waitFor(`!document.querySelector('.tab-scroll').disabled`);
  await js(`document.querySelector('.tab-scroll').click()`);
  await waitFor(`document.querySelector('.tab-scroll').disabled`);
  assert.equal(await js(`(() => {
    const strip = document.querySelector('.window-tabs');
    const event = new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true });
    strip.dispatchEvent(event);
    return event.defaultPrevented && strip.scrollLeft > 0;
  })()`), true, 'A conventional mouse wheel moves the project strip horizontally');
  assert.equal(await js(`(() => {
    const event = new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
    document.querySelector('.window-tabs').dispatchEvent(event);
    return event.defaultPrevented;
  })()`), false, 'Trackpad zoom remains native');
  await js(`document.querySelector('.window-tabs').scrollTo({ left: 100000, behavior: 'instant' })`);
  await waitFor(`document.querySelectorAll('.tab-scroll')[1].disabled`);
  assert.equal(await js(addButtonVisible), true, 'Add project stays fixed outside the scrolling viewport');
  await capture('tabs-overflow-end');
  await js(`document.querySelector('.window-tab.active [role="tab"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))`);
  await waitFor(`document.querySelector('.window-tab:last-child.active')`);
  await waitFor(activeTabVisible);
  assert.equal(await js(`document.activeElement === document.querySelector('.window-tab.active [role="tab"]')`), true);
  win.setContentSize(1024, 760);
  await waitFor('innerWidth === 1024');
  await waitFor(activeTabVisible);
  assert.equal(await js(addButtonVisible), true);
  await capture('tabs-overflow-compact');
  await assertTitlebarDragging();
  // Removing the arrows must use the full available width, including the space they occupied.
  const fittingWidth = await js(`Math.ceil(innerWidth + document.querySelector('.window-tab-items').scrollWidth - document.querySelector('.tab-navigation').clientWidth + 1)`);
  win.setContentSize(fittingWidth, 940);
  await waitFor(`document.querySelectorAll('.tab-scroll').length === 0`);
  win.setContentSize(1480, 940);
  await waitFor('innerWidth === 1480');
  await waitFor(activeTabVisible);
  await js(`document.querySelector('.window-tab.active [role="tab"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`);
  await waitFor(`document.querySelector('.window-tab:first-child.active')`);
  await waitFor(activeTabVisible);
  await startTabDrag('.window-tab:not(.unavailable) [role="tab"]');
  await js(`(() => {
    const strip = document.querySelector('.window-tabs'), r = strip.getBoundingClientRect();
    for (let i = 0; i < 8; i++) strip.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true,
      dataTransfer: window.tabTransfer, clientX: r.right - 2, clientY: r.top + r.height / 2 }));
  })()`);
  assert.equal(await js(`document.querySelector('.window-tabs').scrollLeft > 0`), true, 'Dragging at the edge scrolls hidden tabs into reach');
  await overTab('.tab-add', 'after', 'drop');
  await waitFor(`document.querySelector('.window-tab:last-of-type.active')`);
  assert.deepEqual(await tabNames(), [...missingTabs.map(tab => tab.name), 'GitCat']);
  await js(`document.querySelector('.window-tabs').scrollLeft = 0`);
  await startTabDrag('.window-tab:not(.unavailable) [role="tab"]');
  await js(`(() => {
    const strip = document.querySelector('.window-tabs'), first = strip.querySelector('.window-tab').getBoundingClientRect();
    strip.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.tabTransfer,
      clientX: first.right + 2, clientY: first.top + first.height / 2 }));
  })()`);
  await waitFor(`document.querySelectorAll('.window-tab')[1].classList.contains('active')`);
  assert.deepEqual(await tabNames(), [missingTabs[0].name, 'GitCat', ...missingTabs.slice(1).map(tab => tab.name)], 'A drop in the gap between tabs inserts at that gap');
  restored = null;
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelectorAll('.commit-row').length === 7`);
  // A fast native gesture can deliver the drop before React paints drag-start state.
  await js(`(() => {
    const source = document.querySelector('.window-tab.unavailable [role="tab"]');
    const target = document.querySelector('.window-tab:not(.unavailable)'), r = target.getBoundingClientRect();
    const transfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: r.left + 2, clientY: r.top + 10 }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  })()`);
  await waitFor(`document.querySelector('.window-tab:first-child.unavailable')`);
  await js(`document.querySelector('.window-tab.unavailable [role="tab"]').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, altKey: true, key: 'ArrowRight' }))`);
  await waitFor(`document.querySelector('.window-tab:last-of-type.unavailable')`);
  // A long branch list must scroll inside the sidebar, with its controls staying visible.
  const scrollBranches = Array.from({ length: 48 }, (_, index) => `scroll/item-${String(index).padStart(2, '0')}`);
  for (const name of scrollBranches) git('branch', name);
  restored = { projects: [await service.getSnapshot(repo)], unavailable: [], order: [repo], activePath: repo };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.branch-section input')`);
  await js(`(() => { const input = document.querySelector('.branch-section input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'scroll/item-'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelectorAll('.branch-list .branch-row').length === 48`);
  // Native input requires a focused window; hidden-window wheel delivery is unreliable on hosted Macs.
  win.show();
  win.focus();
  await waitFor('document.hasFocus()');
  for (const height of [940, 720]) {
    win.setContentSize(1480, height);
    await waitFor(`innerHeight === ${height}`);
    for (const mode of [1, 0]) {
      await js(`document.querySelectorAll('.branch-tools .mode-toggle button')[${mode}].click()`);
      await waitFor(`document.querySelectorAll('.branch-list .branch-row').length === 48`);
      assert.equal(await js(`Boolean(document.querySelector('.sidebar-mascot'))`), false, 'The decorative cat takes no sidebar space');
      const viewport = await js(`(() => {
        const list = document.querySelector('.branch-list'), sidebar = document.querySelector('aside.sidebar');
        list.scrollTop = 0;
        const r = list.getBoundingClientRect();
        return { overflows: list.scrollHeight > list.clientHeight, bottomGap: sidebar.getBoundingClientRect().bottom - r.bottom,
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), controlsTop: document.querySelector('.branch-filters').getBoundingClientRect().top };
      })()`);
      assert.equal(viewport.overflows, true, 'The branch list has a bounded scroll viewport');
      assert.ok(viewport.bottomGap <= 12, 'Branches use the space down to the bottom of the sidebar');
      // Let Chromium paint the mode/size change and reset before hit-testing native wheel input.
      await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: viewport.x, y: viewport.y });
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: viewport.x, y: viewport.y, deltaY: -400, deltaX: 0 });
      await waitFor(`document.querySelector('.branch-list').scrollTop > 0`);
      assert.equal(await js(`document.querySelector('.branch-filters').getBoundingClientRect().top`), viewport.controlsTop, 'Scrolling keeps filter controls in place');
      assert.equal(await js(`(() => {
        const list = document.querySelector('.branch-list'); list.scrollTop = list.scrollHeight;
        const last = list.querySelector('.branch-row:last-child').getBoundingClientRect(), r = list.getBoundingClientRect();
        return last.top >= r.top && last.bottom <= r.bottom + 1;
      })()`), true, 'The final branch is reachable in both list modes');
      await capture(`branches-scroll-${height}-${mode === 1 ? 'flat' : 'tree'}`);
    }
  }
  for (const name of scrollBranches) git('branch', '-D', name);
  await js(`localStorage.removeItem(${JSON.stringify(`gitcat-branch-view:${repo}`)})`);
  restored = null;
  win.setContentSize(1480, 940);
  await win.loadFile(path.join(root, 'dist/index.html'));
  // Five commits plus separate WIP rows for the current and linked working folders.
  await waitFor(`document.querySelectorAll('.commit-row').length === 7`);
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
  await waitFor(`document.querySelectorAll('.commit-row').length === 7`);
  // Linked edits are part of the graph, with their own preview and safe navigation.
  assert.equal(await js(`document.querySelectorAll('.commit-row.wip').length`), 2);
  const linkedRow = `[...document.querySelectorAll('.commit-row.wip')].find(row => row.dataset.worktreePath === ${JSON.stringify(linkedWorktree)})`;
  await js(`${linkedRow}.click()`);
  await waitFor(`document.querySelector('.worktree-preview')`);
  assert.match(await js(`document.querySelector('.worktree-preview').innerText`), /worktree-only.txt/);
  assert.equal(await js(`document.querySelectorAll('.worktree-preview .delivery-actions').length`), 0);
  await capture('worktree-graph');
  await js(`${linkedRow}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 200 }))`);
  await waitFor(`document.querySelector('.context-menu')`);
  assert.match(await js(`document.querySelector('.context-menu').innerText`), /Abrir carpeta de trabajo/);
  assert.doesNotMatch(await js(`document.querySelector('.context-menu').innerText`), /Guardar cambios/);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  // Worktrees remain available independently of branch filtering.

  await js(`document.querySelector('.worktrees-button').click()`);
  await waitFor(`document.querySelector('.worktrees-dialog')`);
  assert.equal(await js(`document.querySelectorAll('.worktree-list li').length`), 3);
  assert.match(await js(`document.querySelector('.worktree-list').innerText`), /Abierto aquí[\s\S]*sin rama activa|sin rama activa[\s\S]*Abierto aquí/);
  await assertDialog();
  await capture('worktrees');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(`!document.querySelector('.worktrees-dialog')`);
  await js(`(() => { const input = document.querySelector('.branch-section input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'qa/worktree'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const occupiedBranch = `[...document.querySelectorAll('.branch-row')].find(row => row.querySelector('.branch-main')?.title.startsWith('qa/worktree ·'))`;
  await waitFor(occupiedBranch);
  const occupiedButton = `${occupiedBranch}.querySelector('.branch-switch')`;
  assert.match(await js(`${occupiedButton}.innerText`), /Abrir worktree/);
  assert.ok((await js(`${occupiedButton}.title`)).includes(linkedWorktree));
  assert.ok((await js(`${occupiedButton}.getAttribute('aria-label')`)).includes(linkedWorktree));
  assert.equal(await js(`${occupiedBranch}.querySelector('.branch-worktree-path')?.innerText`), linkedWorktree);
  await js(`${occupiedBranch}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 400 }))`);
  await waitFor(`document.querySelector('.context-menu')`);
  const openFolderMenuItem = `[...document.querySelectorAll('.context-menu button')].find(button => button.innerText.includes('Abrir worktree'))`;
  assert.equal(await js(`${openFolderMenuItem}?.title`), linkedWorktree);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await js(`${occupiedButton}.click()`);
  await waitFor(`document.querySelector('.window-tab.active')?.innerText.includes('Linked worktree')`);
  assert.equal(git('branch', '--show-current'), 'feature/new-menu');
  assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'updated menu\n');
  assert.equal(fs.readFileSync(path.join(linkedWorktree, 'worktree-only.txt'), 'utf8'), 'separate edits');
  assert.equal(await js(`Boolean(document.querySelector('.plan-card, .switch-work'))`), false);
  assert.equal(await js(`Boolean(document.querySelector('.window-tab.active svg[aria-label="Worktree vinculado"]'))`), true);
  assert.equal(await js(`document.querySelectorAll('.window-tab:not(.unavailable)').length`), 1, 'Opening a worktree reuses the repository tab');
  await waitFor(`document.querySelector('.commit-row.head .ref-tag.more')`);
  await js(`document.querySelector('.commit-row.head .ref-tag.more').click()`);
  await waitFor(`document.querySelector('.ref-stack')`);
  assert.equal(await js(`document.querySelectorAll('.ref-stack .ref-worktree').length`), 2);
  await js(`[...document.querySelectorAll('.ref-stack .ref-tag')].find(chip => chip.innerText.includes('feature/new-menu')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(`document.querySelector('.window-tab.active')?.innerText.includes('GitCat')`);
  assert.equal(await js(`Boolean(document.querySelector('.switch-work-dialog'))`), false);
  assert.equal(await js(`document.querySelectorAll('.window-tab:not(.unavailable)').length`), 1);

  await waitFor(`document.querySelectorAll('.commit-row').length === 7`);
  const operationEvent = { id:'ui-progress', repoPath:snapshot.path, startedAt:Date.now()-2000, phase:'executing', state:'running', mutation:true, stopping:false, step:1, total:3 };
  win.webContents.send('operation:progress', operationEvent);
  await waitFor(`document.querySelector('.operation-status')`);
  assert.match(await js(`document.querySelector('.operation-status').innerText`), /Paso 1 de 3[\s\S]*Detener después del paso actual/);
  await js(`document.querySelector('.window-tab.unavailable [role="tab"]').click()`);
  await waitFor(`!document.querySelector('.operation-status')`);
  await js(`document.querySelector('.window-tab:not(.unavailable) [role="tab"]').click()`);
  await waitFor(`document.querySelector('.operation-status')`);
  win.webContents.send('operation:progress', { ...operationEvent, state:'stopped', stopping:true });
  await waitFor(`document.querySelector('.operation-status')?.innerText.includes('no se deshizo nada')`);
  await js(`document.querySelector('.operation-status button').click()`);
  await waitFor(`document.querySelectorAll('.commit-row').length === 7`);
  const before = git('status', '--porcelain');
  await js(`document.querySelector('[aria-label="Compartir para revisión"]').click()`);
  await waitFor(`document.querySelector('.share-review')`);
  await assertDialog();
  assert.match(await js(`document.querySelector('.share-review').innerText`), /archivos sin guardar quedan en este equipo[\s\S]*Conecta primero un remoto/);
  assert.equal(await js(`document.querySelector('.share-review .outline-button').disabled`),true);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await waitFor(`!document.querySelector('.share-review')`);

  // The renderer uses scripted hosting replies; publication is exercised against real Git separately.
  hostingScenario = true;
  await refreshStatus();
  await waitFor(`document.querySelector('.remote-status')?.innerText.includes('code.company.test')`);
  await js(`document.querySelector('[aria-label="Compartir para revisión"]').click()`);
  await waitFor(`document.querySelector('.share-review')`);
  assert.equal(await js(`Boolean(document.querySelector('.share-review input[name="title"], .share-review textarea[name="body"]'))`), false);
  assert.equal(await js(`document.querySelector('.share-review-destination').open`), false);
  await js(`(() => {document.querySelector('.share-review-destination').open = true;const select=document.querySelector('.share-review select[name="provider"]');select.value='gitlab';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await js(`document.querySelector('.share-review .outline-button').click()`);
  await waitFor(`document.querySelector('.share-review .activity-record')`);
  assert.equal(reviewRequests.at(-1).provider, 'gitlab');
  assert.equal(Object.hasOwn(reviewRequests.at(-1), 'title'), false);
  assert.equal(Object.hasOwn(reviewRequests.at(-1), 'body'), false);
  assert.equal(reviewPublished, false, 'Checking leaves publication behind confirmation');
  assert.match(await js(`document.querySelector('.share-review .activity-record').innerText`), /GitLab[\s\S]*org\/team\/repo[\s\S]*anna.work[\s\S]*Saved work for review/);
  await assertDialog();
  await capture('gitlab-review');
  await js(`(() => {
    const title = document.querySelector('.share-review input[name="title"]');
    const body = document.querySelector('.share-review textarea[name="body"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, 'Reviewed after checking');
    title.dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(body, 'Draft entered after checking');
    body.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await js(`document.querySelector('.share-review .primary-button').click()`);
  await waitFor(`document.querySelector('.share-review [role="status"]')?.innerText.includes('merge_requests/1')`);
  assert.equal(reviewPublished, true);
  assert.deepEqual(reviewDrafts.at(-1), { title: 'Reviewed after checking', body: 'Draft entered after checking' });
  const reviewStatus = await js(`document.querySelector('.share-review [role="status"]').innerText`);
  assert.match(reviewStatus, /no pudo guardar toda la operación en Actividad/);
  assert.match(reviewStatus, /Falló una comprobación del repositorio local[\s\S]*Actualiza el proyecto/);
  await js(`document.querySelector('.share-review [role="status"] button').click()`);
  assert.deepEqual(reviewLinks, [reviewUrl]);

  reviewPublished = false;
  reviewScenario = { open: true, noCommits: true };
  const checkReview = `document.querySelector('.share-review > .outline-button').click()`;
  const reviewPrimary = `document.querySelector('.share-review .primary-button')`;
  await js(checkReview);
  await waitFor(reviewPrimary);
  assert.equal(await js(`${reviewPrimary}.innerText.trim()`), 'Abrir revisión');
  assert.equal(await js(`Boolean(document.querySelector('.share-review input[name="title"], .share-review textarea[name="body"]'))`), false);
  const openReviewText = await js(`document.querySelector('.share-review .activity-record').innerText`);
  assert.match(openReviewText, /Estado real de la revisión: OPEN/);
  assert.doesNotMatch(openReviewText, /La confirmación publica/);
  const checkedTime = await js(`document.querySelector('.share-review time').innerText`);
  const localCheckedTime = await js(`new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(${JSON.stringify(reviewCheckedAt)}))`);
  assert.equal(checkedTime, localCheckedTime);
  await js(`${reviewPrimary}.click()`);
  assert.deepEqual(reviewLinks, [reviewUrl, reviewUrl]);
  assert.equal(reviewPublished, false, 'Opening an already published review never invokes publication');

  reviewScenario = { open: true, noCommits: false };
  await js(checkReview);
  await waitFor(reviewPrimary);
  assert.equal(await js(`${reviewPrimary}.innerText.trim()`), 'Publicar en esta revisión');
  assert.equal(await js(`Boolean(document.querySelector('.share-review input[name="title"]'))`), false);
  reviewScenario = { open: false, noCommits: true };
  await js(checkReview);
  await waitFor(reviewPrimary);
  assert.equal(await js(`${reviewPrimary}.innerText.trim()`), 'Publicar y crear una revisión nueva');
  assert.equal(await js(`Boolean(document.querySelector('.share-review input[name="title"]'))`), true);
  assert.equal(await js(`${reviewPrimary}.disabled`), false, 'A published branch can still open its first review');
  reviewScenario = undefined;
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await waitFor(`!document.querySelector('.share-review')`);
  hostingScenario = false;
  await refreshStatus();
  await waitFor(`document.querySelector('.remote-status')?.innerText.includes('Sin remoto')`);
  assert.equal(git('status','--porcelain'),before,'Sharing for review never saves unsaved files');

  for(const provider of ['bitbucket','bitbucket_dc','azure']){
    hostingScenario=provider;reviewPublished=false;
    await refreshStatus();
    await waitFor(`document.querySelector('.remote-status')?.innerText.includes(${JSON.stringify(provider==='bitbucket'?'bitbucket.org':provider==='azure'?'ssh.dev.azure.com':'code.company.test')})`);
    await js(`document.querySelector('[aria-label="Compartir para revisión"]').click()`);
    await waitFor(`document.querySelector('.share-review')`);
    await js(`(() => {document.querySelector('.share-review-destination').open = true;const select=document.querySelector('.share-review select[name="provider"]');select.value=${JSON.stringify(provider)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.querySelector('.share-review select[name="connection"] option[value="ui-${provider}"]')`);
    await js(`(() => {const select=document.querySelector('.share-review select[name="connection"]');select.value='ui-${provider}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await js(`document.querySelector('.share-review .outline-button').click()`);
    await waitFor(`document.querySelector('.share-review .activity-record')`);
    assert.equal(reviewRequests.at(-1).connectionId,`ui-${provider}`);assert.equal(reviewPublished,false);
    assert.match(await js(`document.querySelector('.share-review .activity-record').innerText`),/Anna Work/);
    assert.match(await js(`document.querySelector('.share-review').innerText`),/HTTPS/);
    await assertDialog();await capture(`${provider}-review`);
    await js(`document.querySelector('.share-review .primary-button').click()`);
    await waitFor(`document.querySelector('.share-review [role="status"] button')`);
    assert.equal(reviewPublished,true);
    await js(`document.querySelector('.share-review [role="status"] button').click()`);
    assert.equal(reviewLinks.at(-1),`${nativeUi[provider].location.webUrl}/${provider==='azure'?'pullrequest':'pull-requests'}/1`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);await waitFor(`!document.querySelector('.share-review')`);
  }
  hostingScenario=false;
  await refreshStatus();
  await waitFor(`document.querySelector('.remote-status')?.innerText.includes('Sin remoto')`);

  await js(`document.querySelector('.branch-switch:not(.open-worktree)').click()`);
  await waitFor(`document.querySelector('.switch-work fieldset')`);
  await assertDialog();
  assert.match(await js(`document.querySelector('.switch-work').innerText`), /Cambiar a[\s\S]*Llevar los cambios[\s\S]*Guardar primero en esta rama[\s\S]*Revisar apartar y cambiar/);
  assert.doesNotMatch(await js(`document.querySelector('.switch-work').innerText`), /Restaurar|Trabajo apartado/);
  await js(`document.querySelector('.switch-work-files').open = true; document.querySelector('.switch-work fieldset details').open = true`);
  assert.match(await js(`document.querySelector('.switch-work').innerText`), /app.txt[\s\S]*new-file.txt[\s\S]*Incluir archivos nuevos/);
  assert.equal(git('status','--porcelain'),before,'Reviewing a switch does not stash or save work');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await waitFor(`!document.querySelector('.switch-work')`);

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
  assert.match(await js(`document.querySelector('.repo-toolbar .primary-button').innerText`), /Guardar cambios/);
  assert.match(await js(`document.querySelector('.overview-summary').innerText`), /2 archivos sin guardar[\s\S]*Solo en este equipo[\s\S]*Falta integrar en main/);
  await capture('status-strip');
  // The alternate action is keyboard accessible and Escape returns focus to its trigger.
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', altKey: true }))`);
  await waitFor(`document.querySelector('.context-menu [role="menuitem"]')`);
  assert.match(await js(`document.activeElement.textContent`), /Guardar e integrar en main/);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(`!document.querySelector('.context-menu')`);
  assert.equal(await js(`document.activeElement === document.querySelector('.toolbar-more')`), true);
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
  assert.match(await js(`document.querySelector('.commit-row.wip[data-hash="working-tree"]').innerText`), /WIP/);
  // Every commit says how much it changed, without opening it.
  assert.match(await js(`document.querySelector('.commit-row.head .commit-changes').innerText`), /\+1/);
  // Nothing picked yet: the details pane shows the uncommitted work and its files.
  await waitFor(`document.querySelector('.inspector .changes-view .change-list')`);
  assert.match(await js(`document.querySelector('.inspector .change-summary').innerText`), /1 modificado\n1 añadido/);
  assert.equal(await js(`document.querySelectorAll('.inspector .change-row').length`), 2);
  // Picking a commit shows its message, author and files with their line counts.
  await js(`document.querySelectorAll('.commit-row')[3].click()`);
  await waitFor(`document.querySelector('.commit-inspector .change-row')`);
  assert.match(await js(`document.querySelector('.commit-inspector .detail-message').innerText`), /Integrar el buscador/);
  assert.match(await js(`document.querySelector('.commit-inspector .change-list').innerText`), /search\.txt/);
  await capture('overview-commit');
  // The tree view groups the same files by folder, and the choice is remembered.
  await js(`document.querySelectorAll('.file-list .mode-toggle button')[1].click()`);
  assert.equal(await js(`localStorage.getItem('gitcat-file-list-mode')`), 'tree');
  await js(`document.querySelectorAll('.file-list .mode-toggle button')[0].click()`);
  // Arrow keys walk the graph and the details follow.
  await js(`document.querySelectorAll('.commit-row')[3].querySelector('.commit-content').focus()`);
  await js(`document.querySelector('.graph-scroll').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
  await waitFor(`document.querySelectorAll('.commit-row')[2].classList.contains('selected')`);
  await js(`document.querySelector('.commit-row.wip[data-hash="working-tree"]').click()`);
  await waitFor(`document.querySelector('.inspector .changes-view')`);
  // The new-project button shares the tabs' vertical centre.
  const centres = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.window-tab, .tab-add')].map((node) => { const r = node.getBoundingClientRect(); return r.top + r.height / 2; }))`));
  assert.ok(Math.abs(centres[0] - centres[centres.length - 1]) <= 1, `tab centres ${centres}`);
  // A right click on a commit with a branch offers that branch's actions and the commit's own.
  await js(`(() => { const row = [...document.querySelectorAll('.commit-row')].find((node) => node.querySelector('.ref-tag')?.textContent === 'main'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 300 })); })()`);
  await waitFor(`document.querySelector('.context-menu')`);
  const menuText = await js(`document.querySelector('.context-menu').innerText`);
  for (const entry of [/Cambiar a la rama main/, /Mover feature\/new-menu encima de main/, /Nueva rama desde este commit/, /Revertir este commit/, /Copiar el hash/]) assert.match(menuText, entry);
  // main is already inside feature/new-menu, so a merge would bring nothing and is not offered.
  assert.doesNotMatch(menuText, /Fusionar main en/);
  assert.doesNotMatch(menuText, /Eliminar la rama main|Renombrar/, 'The default branch is never offered for deletion or renaming');
  await capture('context-menu');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(`!document.querySelector('.context-menu')`);
  // The WIP row has its own short menu.
  await js(`document.querySelector('.commit-row.wip[data-hash="working-tree"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 200 }))`);
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
  // Git shortcuts are reachable in the same menu and are absent from the main bar.
  assert.equal(await js(`document.querySelectorAll('.toolbar-tools button').length`), 2);
  assert.match(await js(`document.querySelector('.toolbar-tools').innerText`), /Actualizar estado/);
  await openToolbarMenu();
  for (const action of ['fetch', 'pull', 'push', 'stash', 'branch']) {
    assert.ok(await js(`Boolean(${toolbarItem(action)})`), `${action} stays accessible from the menu`);
  }
  assert.equal(await js(`${toolbarItem('stash')}.disabled`), false);
  assert.equal(await js(`Boolean(${toolbarItem('stash-pop')})`), false);
  await clickToolbarItem('stash');
  await waitFor(`document.querySelector('.plan-card .plan-actions .primary-button')`);
  assert.equal(git('status', '--porcelain'), before, 'Stash is reviewed before clearing files');
  await js(`document.querySelector('.plan-card .plan-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.toolbar-delivery.is-saved')`);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('branch', '--show-current'), 'feature/new-menu');
  fs.writeFileSync(path.join(repo, 'after-stash.txt'), 'keep current work');
  await refreshStatus();
  await waitFor(`document.querySelector('.toolbar-delivery.is-dirty')`);
  await js(`document.querySelector('[aria-label="Trabajo apartado"]').click()`);
  await waitFor(`document.querySelector('.switch-work .activity-record time')`);
  const savedEntry = await js(`document.querySelector('.switch-work .activity-record').innerText`);
  assert.match(savedEntry, /feature\/new-menu[\s\S]*Restaurar[\s\S]*Restaurar y quitar de la lista/);
  await js(`document.querySelector('.switch-work .activity-record .modal-actions button:last-child').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal .plan-actions .primary-button')`);
  assert.match(await js(`document.querySelector('.delivery-review-modal').innerText`), /solo si se restaura correctamente/);
  await js(`document.querySelector('.delivery-review-modal .plan-actions .primary-button').click()`);
  await waitFor(`!document.querySelector('.delivery-review-modal') && document.querySelector('.overview-summary')?.innerText.includes('3 archivos sin guardar')`);
  await js(`document.querySelector('[aria-label="Trabajo apartado"]').click()`);
  await waitFor(`document.querySelector('.switch-work')?.innerText.includes('Todavía no tienes trabajo apartado')`);
  await js(`document.querySelector('.switch-work .modal-heading button').click()`);
  assert.equal(fs.readFileSync(path.join(repo, 'after-stash.txt'), 'utf8'), 'keep current work');
  fs.unlinkSync(path.join(repo, 'after-stash.txt'));
  assert.equal(git('status', '--porcelain'), before, 'Pop restores the original edits and new file');
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
  await refreshStatus();
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
  await waitFor(`document.querySelectorAll('.commit-row').length === 7`);
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
  await waitFor(`document.querySelector('.repo-toolbar .primary-button')`);

  // History has its own short first-use consent; it never includes unsaved files.
  await js(`document.querySelectorAll('.inspector-tabs button')[1].click()`);
  const sendChat = async (message) => {
    await js(`(() => {
      const field = document.querySelector('.chat-compose textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(message)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await js(`document.querySelector('.chat-compose .send-button').click()`);
  };
  await sendChat('¿Qué trajo el último merge?');
  await waitFor(`document.querySelector('.sharing-modal')?.innerText.includes('historial y estado de Git')`);
  assert.equal(assistantRequests.length, 0);
  assert.equal(await js(`Boolean(document.querySelector('.sharing-modal .sharing-files'))`), false);
  await js(`document.querySelector('.sharing-modal .sharing-accept').click()`);
  await waitFor(`document.querySelector('.assistant-answer')?.innerText.includes('integró el buscador')`);
  assert.deepEqual(assistantRequests, [{ question: '¿Qué trajo el último merge?', includeWorkingChanges: false }]);
  assert.equal(await js(`Boolean(document.querySelector('.completion-card, .plan-actions'))`), false);
  assert.match(await js(`document.querySelector('.conversation-turn .ghost-button').innerText`), /Diff completo/);

  await sendChat('Explica los cambios sin guardar');
  await waitFor(`document.querySelector('.sharing-modal .sharing-files')`);
  assert.match(await js(`document.querySelector('.sharing-modal').innerText`), /Incluir cambios[\s\S]*app\.txt/);
  await js(`document.querySelector('.sharing-modal .modal-actions .ghost-button').click()`);
  await waitFor(`document.querySelector('.chat-compose textarea')?.value === 'Explica los cambios sin guardar'`);
  assert.equal(assistantRequests.length, 2, 'Declining the larger scope sends no file content');
  assert.ok(assistantRequests.every((request) => !request.includeWorkingChanges));
  assert.equal(git('status', '--porcelain'), before);
  await js(`document.querySelectorAll('.inspector-tabs button')[0].click()`);

  // Each listed file has its own tick; leaving one out is visible and the count follows.
  const rowFor = (name) => `[...document.querySelectorAll('.inspector .change-row')].find((node) => node.innerText.includes('${name}'))`;
  await waitFor(`${rowFor('new-file.txt')}?.querySelector('.change-include')`);
  assert.equal(await js(`${rowFor('app.txt')}.querySelector('.change-ignore') === null`), true, 'A tracked file offers no ignore rule');
  await js(`${rowFor('new-file.txt')}.querySelector('.change-include').click()`);
  await waitFor(`document.querySelector('.inspector .select-all')?.innerText.includes('Se guardarán 1 de 2 archivos')`);
  assert.match(await js(`${rowFor('new-file.txt')}.title`), /^Nuevo · fuera/);
  assert.equal(await js(`${rowFor('new-file.txt')}.classList.contains('excluded')`), true);
  // What will be saved is shown as one diff of the ticked files only.
  await js(`document.querySelector('.save-preview > button').click()`);
  await waitFor(`document.querySelector('.selection-preview .diff-view')`);
  const selectedDiff = await js(`document.querySelector('.selection-preview .diff-view').innerText`);
  assert.match(selectedDiff, /updated menu/); assert.doesNotMatch(selectedDiff, /new-file/);
  assert.ok(await js(`Boolean(document.querySelector('.changes-view #commit-description') && !document.querySelector('[aria-modal="true"]'))`));
  await capture('selected-diff');
  await js(`document.querySelector('.selection-preview .icon-button').click()`);
  await waitFor(`!document.querySelector('.selection-preview')`);
  await js(`${rowFor('app.txt')}.querySelector('.change-open').click()`);
  await waitFor(`document.querySelector('.selection-preview .discard-file')`);
  await js(`document.querySelector('.selection-preview .discard-file').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal')`);
  assert.match(await js(`document.querySelector('.delivery-review-modal').innerText`), /Descartar los cambios de app\.txt[\s\S]*Se perderán/);
  await js(`document.querySelector('.delivery-review-modal .modal-heading .icon-button').click()`);
  await waitFor(`!document.querySelector('.delivery-review-modal')`);
  assert.equal(git('status', '--porcelain'), before, 'Cancelling the review keeps all edits');
  await js(`${rowFor('new-file.txt')}.querySelector('.change-open').click()`);
  await waitFor(`document.querySelector('.selection-preview .diff-toolbar strong')?.innerText === 'new-file.txt'`);
  assert.equal(await js(`Boolean(document.querySelector('.selection-preview .discard-file'))`), false);
  await js(`document.querySelector('.selection-preview .icon-button').click()`);
  // Ignoring an untracked file previews the exact .gitignore line and writes nothing until confirmed.
  await js(`${rowFor('new-file.txt')}.querySelector('.change-ignore').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal')`);
  const ignoreReview = await js(`document.querySelector('.delivery-review-modal').innerText`);
  assert.match(ignoreReview, /\/new-file\.txt/); assert.match(ignoreReview, /ya están guardados en Git se siguen vigilando/);
  await js(`document.querySelector('.delivery-review-modal .modal-heading .icon-button').click()`);
  await waitFor(`!document.querySelector('.delivery-review-modal')`);
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false, 'Closing the preview writes nothing');

  // Opening the save sends nothing before sharing is agreed: the form stays manual until asked.
  await js(`document.querySelector('.repo-toolbar .primary-button').click()`);
  await waitFor(`document.querySelector('#commit-description')`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(described.length, 0, 'No description is requested before the disclosure');
  assert.equal(await js(`document.querySelector('#commit-description').value`), '');
  assert.equal(await js(`document.querySelector('.delivery-option input').checked`), false, 'Primary save does not also integrate');
  assert.equal(git('status', '--porcelain'), before, 'Opening save never changes Git');
  await js(`document.querySelector('.repo-toolbar .primary-button').click()`);
  await waitFor(`document.activeElement?.id === 'commit-description'`);
  assert.equal(await js(`document.querySelector('.commit-form-actions .primary-button').disabled`), false, 'Review save explains missing input instead of becoming a dead button');
  await js(`document.querySelector('.commit-form-actions .primary-button').click()`);
  await waitFor(`document.activeElement?.id === 'commit-description'`);
  assert.match(await js(`document.querySelector('.save-description-required').innerText`), /descripción breve|genera una/);
  assert.equal(git('status', '--porcelain'), before, 'A missing description never saves work');
  await js(`document.querySelector('.toolbar-more').click()`);
  await waitFor(`document.querySelector('.context-menu [role="menuitem"]')`);
  await js(`document.querySelector('.context-menu [role="menuitem"]').click()`);
  await waitFor(`document.querySelector('.delivery-option input').checked`);
  assert.equal(git('status', '--porcelain'), before, 'Choosing integration still waits for review');
  // Asking for one shows what would leave this computer, file by file, before anything is sent.
  await js(`document.querySelector('.commit-form-heading button').click()`);
  await waitFor(`document.querySelector('.sharing-modal')`);
  const disclosure = await js(`document.querySelector('.sharing-modal').innerText`);
  for (const entry of [/Incluir cambios de GitCat/, /OpenAI \([^,)]+, api\.openai\.com\)/, /app\.txt/, /Se envía/, /No compartir nunca de este repositorio/]) assert.match(disclosure, entry);
  assert.doesNotMatch(disclosure, /new-file\.txt/, 'Only the ticked files are part of the description request');
  assert.equal(described.length, 0, 'Still nothing sent while the disclosure is open');
  await capture('sharing-disclosure');
  await assertDialog();
  await js(`document.querySelector('.sharing-modal .sharing-accept').click()`);
  await waitFor(`document.querySelector('#commit-description')?.value === 'Update menu and add a new file'`);
  assert.deepEqual(described.at(-1), ['app.txt'], 'The description reads only the ticked files');
  await js(`${rowFor('new-file.txt')}.querySelector('.change-include').click()`);
  await waitFor(`document.querySelector('.inspector .select-all')?.innerText.includes('Se guardarán 2 de 2 archivos')`);
  assert.equal(await js(`document.querySelector('#commit-description').value`), '', 'Changing the selection clears the suggestion for the old file set');
  await js(`document.querySelector('.repo-toolbar .primary-button').click()`);
  await js(`new Promise(resolve => setTimeout(resolve, 200))`);
  assert.equal(described.length, 1, 'An already authorized repo stays manual when the save form opens');
  assert.equal(await js(`document.querySelector('#commit-description').value`), '');
  await js(`(() => {
    const field = document.querySelector('#commit-description');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Update menu and add a new file');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await js(`document.querySelector('.delivery-option input').checked`), true);
  assert.match(await js(`document.querySelector('.inspector .change-row[title^="Nuevo · incluido"]').innerText`), /new-file\.txt/);
  // Who the save will be signed as is said beside the form, with where that comes from.
  assert.match(await js(`document.querySelector('.commit-author-note').innerText`), /Se guarda como GitCat QA <qa@example\.test>, configurado solo para este repositorio/);
  assert.equal(await js(`Boolean(document.querySelector('.changes-view .readiness-checklist'))`), false, 'Nothing to set up, so no checklist in the way');
  await capture('changes');
  await js(`document.querySelector('.commit-form-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal')`);
  assert.match(await js(`document.querySelector('.delivery-review-modal .plan-actions .primary-button').innerText`), /Guardar 2 archivos en feature\/new-menu e integrar en main/);
  await capture('review');
  assert.equal(git('branch', '--show-current'), 'feature/new-menu');
  assert.equal(git('status', '--porcelain'), before, 'Review must precede all Git changes');
  await js(`document.querySelector('.delivery-review-modal .plan-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.toolbar-delivery.is-saved')`);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('show', 'main:new-file.txt'), 'new file');
  // Rebase must also be available when the current branch is the repository default.
  await waitFor(`document.querySelector('.repo-toolbar [data-action="refresh"]')?.disabled === false`, 60_000);
  await waitFor(`[...document.querySelectorAll('.ref-tag')].some(node => node.textContent === 'feature/search')`);
  await js(`[...document.querySelectorAll('.ref-tag')].find(node => node.textContent === 'feature/search').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 450, clientY: 300 }))`);
  await waitFor(`document.querySelector('.context-menu')`);
  assert.match(await js(`document.querySelector('.context-menu').innerText`), /Mover main encima de feature\/search \(rebase\)/);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  // Saved and integrated here is still not published anywhere, and the overview says so.
  await waitFor(`document.querySelector('.work-overview')?.dataset.next === 'connect_remote'`);
  assert.match(await stage('saved'), /Solo en este equipo[\s\S]*no es una copia de seguridad hasta que se publica/);
  assert.match(await stage('integrated'), /Estás en main/);
  assert.match(await js(`document.querySelector('.work-overview .overview-next').innerText`), /Conecta un sitio donde publicar[\s\S]*git remote add/);
  assert.match(await js(`document.querySelector('.overview-summary').innerText`), /Solo en este equipo/, 'A save is described as local, never as a backup');
  const journal = path.join(app.getPath('userData'), 'gitcat-activity.json');
  const { ActivityHistory } = await import(pathToFileURL(path.join(root, 'dist-electron/electron/activity-history.js')));
  const activity = new ActivityHistory(journal);
  const activitySnapshot = await service.getSnapshot(repo);
  for (const metadata of [
    { switchWork: { mode: 'set_aside' } },
    { switchWork: { mode: 'restore' } },
    { recovery: { mode: 'undo', commit: activitySnapshot.head } },
    { recovery: { mode: 'revert', commit: activitySnapshot.head } },
    { recovery: { mode: 'restore', commit: activitySnapshot.head } },
    {}
  ]) {
    const id = activity.begin({ steps: [{ operation: 'git_command' }], ...metadata }, activitySnapshot);
    activity.finish(id, activitySnapshot, [{ status: 'completed' }]);
  }
  await js(`document.querySelector('[data-action="activity"]').click()`);
  await waitFor(`document.querySelector('.activity-history .activity-record')`);
  await assertDialog();
  const activityText = await js(`document.querySelector('.activity-history').innerText`);
  assert.match(activityText, /Guardar cambios en feature\/new-menu[\s\S]*Completada/);
  assert.doesNotMatch(activityText, /Revisar rama de recuperación|Borrar actividad de este proyecto|\b[a-f0-9]{40}\b/);
  assert.equal(await js(`document.querySelector('.activity-settings').open`), false);
  const activityTitles = await js(`[...document.querySelectorAll('.activity-entry > summary strong')].map(entry => entry.innerText)`);
  for (const action of ['Apartar trabajo', 'Restaurar trabajo apartado', 'Deshacer guardado y conservar archivos', 'Revertir guardado con un nuevo commit', 'Crear rama de recuperación', 'Operación de Git']) {
    assert.ok(activityTitles.includes(`${action} en main`), `Activity should show the confirmed action: ${action}`);
  }
  assert.doesNotMatch(activityText, /git_command|git (stash|reset|branch|revert)/);
  const recoveryEntry = `document.querySelector('.activity-entry[data-has-save="true"]')`;
  await js(`${recoveryEntry}.querySelector('summary').click()`);
  assert.equal(recoveryChecks.length, 0, 'Browsing Activity does not query publishing destinations');
  assert.match(await js(`${recoveryEntry}.innerText`), /Guardar cambios · completado/);
  assert.equal(await js(`${recoveryEntry}.querySelector('.activity-entry-technical').open`), false);
  await assertDialog();
  const savedRecord = activity.list(repo).entries.find(entry => entry.steps.some(step => step.operation === 'commit' && step.status === 'completed'));
  const savedCommit = savedRecord.steps.find(step => step.operation === 'commit').afterHead;
  const tipBeforeRecoveryReview = git('rev-parse', 'HEAD');
  const canUndoTip = savedCommit === tipBeforeRecoveryReview;
  await js(`${recoveryEntry}.querySelector('.activity-entry-recovery button').click()`);
  await waitFor(`${recoveryEntry}.querySelector('.primary-button, [role="alert"]')`);
  assert.match(await js(`${recoveryEntry}.innerText`), canUndoTip ? /Revisar deshacer y conservar archivos/ : /Revisar reversión con un commit nuevo/);
  assert.equal(recoveryChecks.length, 1);
  await js(`${recoveryEntry}.querySelector('.primary-button').click()`);
  await waitFor(`document.querySelector('.delivery-review-modal')`);
  assert.match(await js(`document.querySelector('.delivery-review-modal').innerText`), canUndoTip
    ? /Deshacer el último guardado conservando los archivos/ : /Crear commit de reversión/);
  assert.equal(git('rev-parse', 'HEAD'), tipBeforeRecoveryReview, 'Recommendations and their review leave history alone');
  await js(`document.querySelector('.delivery-review-modal .plan-actions .ghost-button').click()`);
  await waitFor(`!document.querySelector('.activity-history')`);
  const corruptHistory = '{"retentionDays":';
  const headBeforeRepair = git('rev-parse', 'HEAD');
  fs.writeFileSync(journal, corruptHistory);
  await js(`document.querySelector('[data-action="activity"]').click()`);
  await waitFor(`document.querySelector('.activity-history [role="alert"]')?.innerText.includes('no pudo leer el historial')`);
  await js(`document.querySelector('.activity-history .outline-button').click()`);
  await waitFor(`document.querySelector('.activity-history .primary-button')?.innerText.includes('Conservar una copia')`);
  assert.equal(fs.readFileSync(journal, 'utf8'), corruptHistory, 'Opening the confirmation preserves the original');
  await js(`document.querySelector('.activity-history .primary-button').click()`);
  await waitFor(`document.querySelector('.activity-history [role="status"]')?.innerText.includes('El historial ilegible se guardó')`);
  const backup = fs.readdirSync(path.dirname(journal)).find(name => name.startsWith('gitcat-activity.json.unreadable-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(journal), backup), 'utf8'), corruptHistory);
  assert.equal(git('rev-parse', 'HEAD'), headBeforeRepair);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape' }))`);
  await waitFor(`!document.querySelector('.activity-history')`);
  // A push with nowhere to go is explained from the repository itself, with the way on, and the
  // assistant is not needed for it: no provider request is made.
  const headBeforePush = git('rev-parse', 'HEAD');
  await clickToolbarItem('push');
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
  for (const entry of [/aún no tiene dónde publicarse/, /Comprobado en este equipo/, /Se detuvo aquí/, /Tus commits están a salvo/, /Conectar un remoto/]) assert.match(recoveryText, entry);
  assert.equal(recoverCalls, 0, 'A failure GitCat can prove needs no assistant');
  assert.match(await js(`document.querySelector('.recovery-ask-assistant')?.innerText`), /Pedir ayuda al asistente/);
  await js(`document.querySelector('.recovery-card').scrollIntoView()`);
  await capture('recovery-card');
  await js(`[...document.querySelectorAll('.recovery-card .recovery-actions button')].find((node) => node.innerText.includes('Conectar un remoto')).click()`);
  await waitFor(`document.querySelector('.input-modal')?.innerText.includes('Dirección del remoto')`);
  await js(`document.querySelector('.input-modal .modal-heading .icon-button').click()`);
  await waitFor(`!document.querySelector('.input-modal')`);
  assert.equal(git('remote'), '', 'Offering a way on changes nothing');
  assert.equal(git('rev-parse', 'HEAD'), headBeforePush);
  // A direct push address must not display the access or credentials of a different named remote.
  const namedRemote = path.join(scratch, 'named-publish.git');
  const directRemote = path.join(scratch, 'direct-publish.git');
  git('init', '--bare', namedRemote);
  git('init', '--bare', directRemote);
  git('remote', 'add', 'origin', namedRemote);
  git('config', 'branch.main.pushRemote', directRemote);
  git('config', 'push.default', 'current');
  const accessChecks = readinessRequests.filter(entry => entry.access).length;
  await clickToolbarItem('push');
  const directPlan = '.plan-card:has(.plan-actions .primary-button)';
  await waitFor(`document.querySelector(${JSON.stringify(directPlan)} + ' .plan-goal')?.innerText.includes(${JSON.stringify(directRemote)})`);
  assert.equal(await js(`Boolean(document.querySelector(${JSON.stringify(directPlan)} + ' .readiness-checklist'))`), false);
  assert.equal(readinessRequests.filter(entry => entry.access).length, accessChecks);
  await js(`document.querySelector(${JSON.stringify(directPlan)} + ' .plan-header .mini-icon').click()`);
  await waitFor(`!document.querySelector(${JSON.stringify(directPlan)})`);
  git('config', '--unset', 'branch.main.pushRemote');
  git('config', '--unset', 'push.default');
  git('remote', 'remove', 'origin');
  // Double-clicking a local branch label in the graph opens the same review.
  await waitFor(`[...document.querySelectorAll('.ref-tag')].some((node) => node.textContent === 'feature/search')`);
  await js(`[...document.querySelectorAll('.ref-tag')].find((node) => node.textContent === 'feature/search').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(`document.querySelector('.plan-card .plan-actions .primary-button')`);
  assert.equal(git('branch', '--show-current'), 'main');
  await js(`document.querySelector('.plan-card .plan-actions .primary-button').click()`);
  for (let attempt = 0; attempt < 100 && git('branch', '--show-current') !== 'feature/search'; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(git('branch', '--show-current'), 'feature/search');
  await waitFor(`document.querySelector('.toolbar-field.branch strong')?.textContent === 'feature/search'`);
  // A background read can show the new branch while checkout is still collecting
  // its final result. Finish that action before simulating work in another tool.
  await waitFor(`document.querySelector('.repo-toolbar [data-action="refresh"]')?.disabled === false`, 60_000);
  // Work done outside GitCat appears on its own when the window comes back, without pressing Refresh.
  assert.equal(await js(`Boolean(document.querySelector('.activity-strip'))`), false, 'No branch review strip');
  git('branch', 'outside/terminal');
  // A read is skipped while GitCat is still finishing the checkout, so focus is offered until one lands.
  await waitFor(`document.querySelector('aside.sidebar').textContent.includes('outside') || (window.dispatchEvent(new Event('focus')), false)`);
  // Credential-like files appear normally in the save list, with no secret warning or review gate.
  fs.writeFileSync(path.join(repo, '.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
  // Background reads preserve a selected commit. Wait for the new working row,
  // then select it explicitly instead of relying on incidental selection timing.
  await waitFor(`document.querySelector('.commit-row.wip[data-hash="working-tree"]') || (window.dispatchEvent(new Event('focus')), false)`);
  await js(`document.querySelector('.commit-row.wip[data-hash="working-tree"]').click()`);
  await waitFor(`document.querySelector('.inspector .change-list')?.textContent.includes('.env')`);
  assert.equal(await js(`Boolean(document.querySelector('.secret-warning, .change-badge.secret'))`), false);
  assert.doesNotMatch(await js(`document.querySelector('.changes-view').innerText`), /posible secreto|Revisé estos archivos/);
  await capture('save-without-secret-warning');
  // One explicit click saves only the selected file, without opening a second review.
  fs.writeFileSync(path.join(repo, 'one-click.txt'), 'save only this\n');
  await waitFor(`${rowFor('one-click.txt')} || (window.dispatchEvent(new Event('focus')), false)`);
  await js(`${rowFor('.env')}.querySelector('.change-include').click()`);
  await js(`(() => {
    const field = document.querySelector('#commit-description');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Save one file');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(`document.querySelector('.commit-form-actions .primary-button')?.innerText.includes('Guardar 1 archivo')`);
  const saveBefore = git('rev-parse', 'HEAD');
  await js(`document.querySelector('.commit-form-actions .primary-button').click()`);
  for (let attempt = 0; attempt < 100 && git('rev-parse', 'HEAD') === saveBefore; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(git('log', '-1', '--format=%s'), 'Save one file');
  assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'one-click.txt');
  assert.equal(git('status', '--porcelain'), '?? .env');
  assert.equal(await js(`Boolean(document.querySelector('.delivery-review-modal'))`), false);

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
  await js(`document.querySelector('.repo-toolbar .primary-button').click()`);
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

  // A historical commit made outside GitCat can be reverted even with no provider configured.
  cwrite('revert-only.txt', 'temporary content\n');
  cgit('add', 'revert-only.txt'); cgit('commit', '-qm', 'Archivo temporal');
  const targetToRevert = cgit('rev-parse', 'HEAD');
  cwrite('keep.txt', 'independent content\n');
  cgit('add', 'keep.txt'); cgit('commit', '-qm', 'Archivo que se conserva');
  const beforeRevert = await service.getSnapshot(conflictRepo);
  restored = { projects: [beforeRevert], unavailable: [], order: [beforeRevert.path], activePath: beforeRevert.path };
  await win.loadFile(path.join(root, 'dist/index.html'));
  const revertRow = `document.querySelector('.commit-row[data-hash="${targetToRevert}"]')`;
  const showRevert = async () => {
    await waitFor(revertRow);
    await js(`${revertRow}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 300 }))`);
    await waitFor(`document.querySelector('.context-menu [data-action="revert"]:enabled')`);
    await js(`document.querySelector('.context-menu [data-action="revert"]').click()`);
    await waitFor(`document.querySelector('.delivery-review-modal')`);
  };
  await showRevert();
  assert.match(await js(`document.querySelector('.delivery-review-modal').innerText`), /Archivo temporal[\s\S]*commit nuevo/);
  assert.equal(await js(`Boolean(document.querySelector('.sharing-modal'))`), false);
  assert.equal(cgit('rev-parse', 'HEAD'), beforeRevert.head);
  await js(`document.querySelector('.delivery-review-modal .plan-actions .ghost-button').click()`);
  await waitFor(`!document.querySelector('.delivery-review-modal')`);
  assert.equal(cgit('rev-parse', 'HEAD'), beforeRevert.head);
  await showRevert();
  await js(`document.querySelector('.delivery-review-modal .plan-actions .primary-button').click()`);
  for (let attempt = 0; attempt < 100 && cgit('rev-parse', 'HEAD') === beforeRevert.head; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(cgit('rev-parse', 'HEAD^'), beforeRevert.head);
  assert.equal(fs.existsSync(path.join(conflictRepo, 'revert-only.txt')), false);
  assert.equal(fs.readFileSync(path.join(conflictRepo, 'keep.txt'), 'utf8'), 'independent content\n');

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
  await resizeContent(1280, 800, 1.5);
  await js(`document.querySelector('.settings-modal .modal-actions button').focus()`);
  assert.equal(await js(`(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })()`), true, 'Dialog primary actions reachable at 150% zoom on a laptop');
  await capture('settings-large-text');
  await resizeContent(800, 700);
  assert.equal(await js(`(() => {
    const modal = document.querySelector('.settings-modal');
    const ai = modal.querySelector('.ai-section').getBoundingClientRect();
    const readiness = modal.querySelector('.readiness-section').getBoundingClientRect();
    return readiness.top > ai.top && modal.querySelector('.modal-actions').getBoundingClientRect().bottom <= innerHeight;
  })()`), true, 'Settings stacks sections and keeps Close visible in a compact window');
  await resizeContent(1480, 940);
  const settingsLayout = await js(`(() => {
    const modal = document.querySelector('.settings-modal');
    const ai = modal.querySelector('.ai-section').getBoundingClientRect();
    const readiness = modal.querySelector('.readiness-section').getBoundingClientRect();
    const bounds = modal.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, aiRight: ai.right, readinessLeft: readiness.left, footerVisible: modal.querySelector('.modal-actions').getBoundingClientRect().bottom <= innerHeight };
  })()`);
  assert.ok(settingsLayout.width >= 900 && settingsLayout.height <= 820, 'Settings uses a broad, bounded dialog on a desktop window');
  assert.ok(settingsLayout.aiRight < settingsLayout.readinessLeft, 'AI setup and repository readiness use separate columns');
  assert.equal(settingsLayout.footerVisible, true, 'Settings close action stays visible below scrolling content');
  const settingsText = () => js(`document.querySelector('.settings-modal').innerText`);
  await waitFor(`document.querySelector('.settings-modal .readiness-row[data-item="author"]')`);
  const guide = await settingsText();
  assert.match(await js(`document.querySelector('.settings-modal .model-option').innerText`), /gpt-6-luna/);
  assert.equal(await js(`document.querySelector('.settings-modal .model-option input').checked`), true, 'The default model is the recommended choice');
  // Without a project, Settings still says whether Git is ready and who saves would be signed as.
  for (const entry of [/Listo para guardar y publicar/, /Git \d\S* está listo/, /Git todavía no sabe quién guarda/, /No es un inicio de sesión/]) assert.match(guide, entry);
  await js(`document.querySelector('.settings-modal .readiness-section').scrollIntoView()`);
  await capture('settings-readiness');
  await js(`document.querySelector('.settings-modal .hosting-accounts summary').click()`);
  await waitFor(`document.querySelector('.settings-modal .hosting-accounts[open]')`);
  const hostingSetText=(selector,value)=>js(`(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await hostingSetText('.hosting-accounts label:nth-of-type(3) input','anna@example.test');
  await hostingSetText('.hosting-accounts input[type="password"]','synthetic-ui-personal-token');
  await js(`document.querySelector('.hosting-accounts fieldset .outline-button').click()`);
  await waitFor(`document.querySelector('.hosting-accounts [role="status"]')?.innerText.includes('Cuenta verificada')`);
  assert.deepEqual(hostingConnectRequests.at(-1),{provider:'bitbucket',baseUrl:'https://bitbucket.org',username:'anna@example.test',hasToken:true});
  assert.equal(await js(`document.querySelector('.hosting-accounts input[type="password"]').value`),'','The hosting token leaves the field once saved');
  assert.doesNotMatch(await js(`document.querySelector('.hosting-accounts').innerText`),/synthetic-ui-personal-token/);
  assert.match(await js(`document.querySelector('.hosting-accounts').innerText`),/cifran en este equipo[\s\S]*nunca se envían al asistente de IA/);
  await assertDialog();await capture('hosting-account-connection');
  await js(`document.querySelector('.settings-modal .hosting-accounts summary').click()`);
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
  assert.equal(connectRequests.at(-1).model, 'gpt-6-luna');
  assert.equal(connectRequests.at(-1).hasKey, true);
  assert.equal(await js(`document.querySelector('.settings-modal input[type="password"]').value`), '', 'The key leaves the field once saved');
  await capture('settings-connected');
  await js(`document.querySelector('.settings-modal .modal-actions .ghost-button').click()`);
  await waitFor(`document.querySelector('.welcome-ai.connected')`);
  // Secure storage unavailable: the key field is closed and the reason is plain, with a retry.
  connected = false; secureStorage = false;
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.welcome-card.first-run')`);
  await js(`document.querySelector('.topbar .top-actions .icon-button:last-child').click()`);
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
  for (const entry of [/Antes de tu primer guardado/i, /Git \d\S* está listo/, /Git todavía no sabe quién guarda/, /Poner nombre y correo…/]) assert.match(firstSaveChecklist, entry);
  await capture('first-save-checklist');
  await js(`[...document.querySelectorAll('.changes-view .readiness-actions button')].find((node) => node.innerText.includes('Poner nombre y correo')).click()`);
  await waitFor(`document.querySelectorAll('.identity-modal .identity-scope').length === 2`);
  const identityText = await js(`document.querySelector('.identity-modal').innerText`);
  for (const entry of [/Solo este repositorio/, /Todos los repositorios de este equipo/, /Ahora: sin configurar/, /no es un inicio de sesión/]) assert.match(identityText, entry);
  assert.equal(await js(`document.querySelector('.identity-scope[data-scope="local"] input').checked`), true, 'This repository only is the default');
  await setText('.identity-modal label:nth-of-type(1) input', 'QA Recetas');
  await setText('.identity-modal label:nth-of-type(2) input', 'recetas@example.test');
  await js(`document.querySelector('.identity-scope[data-scope="global"] input').click()`);
  await waitFor(`document.querySelector('.identity-scope[data-scope="global"] input').checked`);
  await capture('identity-review');
  await js(`document.querySelector('.identity-modal .primary-button').click()`);
  await waitFor(`document.querySelector('.plan-card .plan-actions .primary-button')`);
  const identityPlan = await js(`document.querySelector('.plan-card').textContent`);
  for (const entry of [/todos los repositorios de este equipo como QA Recetas <recetas@example\.test>/, /Todavía no hay una identidad global/, /conservan su autor/, /git config --global user\.name/]) assert.match(identityPlan, entry);
  assert.equal(fs.readFileSync(globalGitConfig, 'utf8'), '', 'Nothing is written before the confirmation');
  await js(`document.querySelector('.plan-card .plan-actions .primary-button').click()`);
  for (let attempt = 0; attempt < 100 && !fs.readFileSync(globalGitConfig, 'utf8').includes('recetas@example.test'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(fs.readFileSync(globalGitConfig, 'utf8'), /name = QA Recetas[\s\S]*email = recetas@example\.test/);
  assert.throws(() => execFileSync('git', ['config', '--local', 'user.name'], { cwd: plain, stdio: 'ignore' }), 'The global choice leaves the repository settings alone');
  await js(`document.querySelector('.inspector-tabs button').click()`);
  await waitFor(`document.querySelector('.changes-view .readiness-row[data-item="author"][data-state="ok"]')`);
  assert.match(await js(`document.querySelector('.changes-view .readiness-row[data-item="author"]').innerText`), /QA Recetas <recetas@example\.test>[\s\S]*configurado para todos los repositorios de este equipo/);
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
  if (process.platform === 'win32') {
    await setText('.clone-form input', 'https://example.test/team/CON.git');
    await waitFor(`document.querySelectorAll('.clone-form input')[1].value === 'repository-CON'`);
  }
  await setText('.clone-form input', `https://127.0.0.1:${silent.address().port}/octo/demo.git`);
  await waitFor(`document.querySelectorAll('.clone-form input')[1].value === 'demo'`);
  if (process.platform === 'win32') {
    for (const name of ['NUL.txt', 'CON', 'notes.', 'a*b']) {
      await setText('.clone-form label:nth-of-type(2) input', name);
      await waitFor(`document.querySelector('.clone-form .setup-problem[role="alert"]')`);
      assert.equal(await js(`document.querySelector('.clone-form .primary-button').disabled`), true, `Windows refuses ${name} before a clone starts`);
      assert.equal(await js(`document.querySelector('.setup-preview')`), null);
    }
    await setText('.clone-form label:nth-of-type(2) input', 'demo');
    await waitFor(`!document.querySelector('.clone-form .setup-problem[role="alert"]')`);
  }
  await js(`document.querySelector('.setup-parent button').click()`);
  await waitFor(`document.querySelector('.setup-preview')`);
  const clonePreview = await js(`document.querySelector('.setup-preview').innerText`);
  assert.match(clonePreview, /La copia se creará en[\s\S]*No se toca nada más/);
  assert.ok(clonePreview.includes(path.join(cloneParent, 'demo')), 'The preview names the exact destination on this platform');
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
  await waitFor(`!document.querySelector('.setup-modal') && document.querySelector('.graph-empty.first-save code')`);
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
  // folder on this computer, so nothing reaches a network.
  await js(`document.querySelector('.top-actions .icon-button:last-child').click()`);
  await waitFor(`document.querySelector('.settings-modal .readiness-access[data-access="ok"]')`);
  const remoteReadiness = await js(`document.querySelector('.settings-modal .readiness-row[data-item="remote"]').innerText`);
  for (const entry of [/Se publica en \S*empty-remote\.git/, /origin · una carpeta de este equipo · el destino que esta rama ya sigue|origin · una carpeta de este equipo · el habitual, origin/, /Acceso confirmado/, /Comprobar el acceso de nuevo/]) assert.match(remoteReadiness, entry);
  assert.match(await js(`document.querySelector('.settings-modal .readiness-row[data-item="author"]').innerText`), /QA Recetas <recetas@example\.test>[\s\S]*configurado para todos los repositorios de este equipo/);
  await js(`document.querySelector('.settings-modal .readiness-section').scrollIntoView()`);
  await capture('settings-readiness-remote');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await waitFor(`!document.querySelector('.settings-modal')`);

  const emptyClone = path.join(cloneParent, 'empty-start');
  const emptyGit = (...args) => execFileSync('git', args, { cwd: emptyClone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const newRemoteAddress = path.join(setupRoot, 'new address.git');
  execFileSync('git', ['init', '-q', '--bare', newRemoteAddress]);
  emptyGit('remote', 'add', 'mirror', emptyRemote);
  await refreshStatus();
  await waitFor(`document.querySelector('.remote-status')?.innerText.includes('+1')`);
  const reviewRemoteEdit = async () => {
    await js(`document.querySelector('.top-actions .icon-button:last-child').click()`);
    await waitFor(`document.querySelector('.remote-settings-controls select option[value="mirror"]')`);
    await js(`(() => {
      const select = document.querySelector('.remote-settings-controls select');
      select.value = 'mirror';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(`document.querySelector('.edit-remote-url')?.innerText.includes('mirror')`);
    await js(`document.querySelector('.edit-remote-url').click()`);
    await waitFor(`document.querySelector('.input-modal h2')?.innerText === 'Editar la URL de mirror'`);
    await setText('.input-modal input', newRemoteAddress);
    await js(`document.querySelector('.input-modal .primary-button').click()`);
    await waitFor(`document.querySelector('.delivery-review-modal')`);
    const review = await js(`document.querySelector('.delivery-review-modal').innerText`);
    assert.match(review, /Cambiar la dirección de mirror[\s\S]*empty-remote\.git[\s\S]*new address\.git/);
    assert.equal(emptyGit('remote', 'get-url', 'mirror'), emptyRemote);
  };
  await reviewRemoteEdit();
  await js(`document.querySelector('.delivery-review-modal .plan-actions .ghost-button').click()`);
  await waitFor(`!document.querySelector('.delivery-review-modal')`);
  assert.equal(emptyGit('remote', 'get-url', 'mirror'), emptyRemote);
  await reviewRemoteEdit();
  await js(`document.querySelector('.delivery-review-modal .plan-actions .primary-button').click()`);
  await waitFor(`document.querySelector('.remote-status')?.getAttribute('title').includes('new address.git')`);
  assert.equal(emptyGit('remote', 'get-url', 'mirror'), newRemoteAddress);
  assert.equal(emptyGit('remote', 'get-url', '--push', 'mirror'), newRemoteAddress);
  assert.equal(emptyGit('remote', 'get-url', 'origin'), emptyRemote);

  await js(`document.querySelector('[aria-label="Crear proyecto de práctica desechable"]').click()`);
  await waitFor(`document.querySelector('.practice-guide')`);
  assert.match(await js(`document.querySelector('.practice-guide').innerText`),/sin remoto[\s\S]*no necesita IA/);
  await js(`document.querySelector('.practice-guide .practice-actions button').click()`);
  await waitFor(`document.querySelector('.practice-guide').innerText.includes('1 archivos sin guardar')`);
  await js(`document.querySelector('.practice-guide select').value='4'; document.querySelector('.practice-guide select').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(`document.querySelector('.practice-guide p').innerText.includes('Dos ramas de ejemplo')`);
  await capture('practice-lessons');
  assert.equal(git('status','--porcelain').includes('.env'),true,'Practice edits leave the original project untouched');

  // The graph preserves the clicked remote identity and reviews a divergent update before applying it.
  const copies = path.join(scratch, 'Copies');
  const copiesRemote = path.join(scratch, 'copies-remote.git');
  const copiesWriter = path.join(scratch, 'copies-writer');
  const at = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  at(scratch, 'init', '-q', '-b', 'main', copies);
  at(copies, 'config', 'user.name', 'QA'); at(copies, 'config', 'user.email', 'qa@example.test');
  fs.writeFileSync(path.join(copies, 'base.txt'), 'base'); at(copies, 'add', '.'); at(copies, 'commit', '-qm', 'base');
  at(scratch, 'clone', '-q', '--bare', copies, copiesRemote);
  at(copies, 'remote', 'add', 'origin', copiesRemote); at(copies, 'fetch', '-q');
  at(copies, 'branch', '--set-upstream-to=origin/main', 'main');
  restored = { projects: [await service.getSnapshot(copies)], unavailable: [], order: [copies], activePath: copies };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.ref-tag.head .ref-cloud')`);
  assert.equal(await js(`document.querySelectorAll('.commit-row .ref-tag.head .lucide-check').length`), 1, 'Current matching copies need only one check');
  assert.match(await js(`document.querySelector('.ref-tag.head').title`), /Las copias local y remota coinciden/);
  assert.equal(await js(`document.querySelectorAll('.branch-presence .branch-sync-badge .lucide-check').length`), 1, 'Sidebar still shows matching copies');
  await capture('copies-synced');
  await js(`document.querySelector('.ref-tag.head button.ref-cloud').click()`);
  await waitFor(`document.querySelector('.sync-modal')`);
  assert.match(await js(`document.querySelector('.sync-modal').innerText`), /origin\/main/);
  await js(`document.querySelector('.sync-modal .ghost-button').click()`);
  at(copies, 'branch', '--track', 'ui/tracked', 'origin/main');
  restored = { projects: [await service.getSnapshot(copies)], unavailable: [], order: [copies], activePath: copies };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.branch-section input')`);
  await js(`(() => {
    const input = document.querySelector('.branch-section input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'ui/tracked');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const trackedRow = `document.querySelector('.branch-list .branch-row')`;
  await waitFor(`${trackedRow}?.querySelector('.branch-main')?.title.includes('ui/tracked')`);
  assert.match(await js(`${trackedRow}.querySelector('.branch-main').title`), /doble clic para cambiar/i);
  await js(`${trackedRow}.querySelector('.branch-main').click()`);
  assert.equal(at(copies, 'branch', '--show-current'), 'main');
  assert.equal(await js(`Boolean(document.querySelector('.plan-card .plan-actions, .sync-modal'))`), false);
  for (const gesture of [
    `${trackedRow}.querySelector('.branch-main').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
    `${trackedRow}.querySelector('.branch-switch').click()`
  ]) {
    await js(gesture);
    await waitFor(`document.querySelector('.plan-card:has(.plan-actions)')?.innerText.includes('ui/tracked')`);
    assert.equal(await js(`Boolean(document.querySelector('.sync-modal'))`), false);
    assert.equal(at(copies, 'branch', '--show-current'), 'main');
    await js(`document.querySelector('.plan-card .plan-actions .ghost-button').click()`);
    await waitFor(`!document.querySelector('.plan-card .plan-actions')`);
  }
  at(copies, 'branch', '-d', 'ui/tracked');
  at(scratch, 'clone', '-q', copiesRemote, copiesWriter);
  at(copiesWriter, 'config', 'user.name', 'QA'); at(copiesWriter, 'config', 'user.email', 'qa@example.test');
  fs.writeFileSync(path.join(copies, 'local.txt'), 'local'); at(copies, 'add', '.'); at(copies, 'commit', '-qm', 'local');
  const localTip = at(copies, 'rev-parse', 'HEAD');
  const publishedTip = at(copies, 'rev-parse', 'origin/main');
  restored = { projects: [await service.getSnapshot(copies)], unavailable: [], order: [copies], activePath: copies };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.work-overview')?.dataset.next === 'publish_saved'`);
  assert.equal(await js(`document.querySelector('.toolbar-delivery button').innerText.trim()`), 'Publicar 1 commit');
  await openToolbarMenu();
  assert.equal(await js(`Boolean(${toolbarItem('push')})`), false, 'Push is represented by the visible work action');
  await closeToolbarMenu();
  await js(`document.querySelector('.toolbar-delivery button').click()`);
  await waitFor(`document.querySelector('.plan-card .plan-actions .primary-button')`);
  assert.equal(at(copies, '--git-dir', copiesRemote, 'rev-parse', 'main'), publishedTip);
  await js(`document.querySelector('.plan-card .plan-actions .ghost-button').click()`);
  fs.writeFileSync(path.join(copiesWriter, 'remote.txt'), 'remote'); at(copiesWriter, 'add', '.'); at(copiesWriter, 'commit', '-qm', 'remote'); at(copiesWriter, 'push', '-q');
  const remoteTip = at(copiesWriter, 'rev-parse', 'HEAD'); at(copies, 'fetch', '-q');
  restored = { projects: [await service.getSnapshot(copies)], unavailable: [], order: [copies], activePath: copies };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await waitFor(`document.querySelector('.ref-tag.remote')?.textContent === 'origin/main'`);
  assert.equal(await js(`Boolean(document.querySelector('.ref-tag.head .lucide-laptop'))`), true);
  assert.match(await js(`document.querySelector('.ref-tag.head').title`), /Copia local[\s\S]*Copias divergidas: 1 commits locales y 1 remotos/);
  assert.equal(await js(`document.querySelectorAll('.commit-row .ref-tag.head .lucide-check').length`), 1);
  assert.equal(await js(`Boolean(document.querySelector('.ref-tag.head .branch-sync-badge.diverged .lucide-git-fork'))`), true, 'Divergence stays visible on the current branch');
  await capture('copies-diverged');
  await clickPull();
  await waitFor(`document.querySelector('#sync-title')`);
  assert.match(await js(`document.querySelector('.sync-modal').innerText`), /main tiene 1 commit.*origin\/main tiene 1 commit/);
  assert.equal(at(copies, 'rev-parse', 'HEAD'), localTip);
  await js(`document.querySelector('.sync-modal .ghost-button').click()`);
  await js(`document.querySelector('.ref-tag.remote').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await waitFor(`document.querySelector('#sync-title')`);
  assert.match(await js(`document.querySelector('.sync-modal .recovery-option').innerText`), /Actualizar main dando prioridad a origin\/main/);
  await js(`document.querySelector('.input-modal .ghost-button').click()`);
  await js(`document.querySelector('.ref-tag.head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  assert.equal(await js(`Boolean(document.querySelector('.sync-modal'))`), false, 'Double click on the current local branch does not sync');
  await js(`document.querySelector('.ref-tag.head').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 600, clientY: 350 }))`);
  await waitFor(`document.querySelector('.context-menu [data-action="sync-remote"]')`);
  await js(`document.querySelector('.context-menu [data-action="sync-remote"]').click()`);
  await waitFor(`document.querySelector('#sync-title')`);
  assert.equal(await js(`document.querySelectorAll('.sync-modal select').length`), 0, 'The clicked copies are already known');
  await js(`document.querySelector('.sync-modal .recovery-option').click()`);
  await waitFor(`document.querySelector('.plan-card .plan-actions .primary-button')`);
  assert.equal(at(copies, 'rev-parse', 'HEAD'), localTip, 'Remote double click prepares an update for review');
  assert.equal(await js(`Boolean(document.querySelector('.plan-stale'))`), false, 'Fetched facts are shown beside the prepared plan');
  assert.match(await js(`document.querySelector('.plan-goal').innerText`), /origin\/main[\s\S]*conservando tus commits locales/);
  assert.match(await js(`document.querySelector('.plan-goal').innerText`), /prioridad a origin\/main/);
  await capture('copies-update-review');
  await js(`document.querySelector('.plan-card .plan-actions .primary-button').click()`);
  await waitFor(`!document.querySelector('.plan-card .plan-actions .primary-button') && !document.querySelector('.branch-sync-badge.diverged')`);
  at(copies, 'merge-base', '--is-ancestor', localTip, 'HEAD'); at(copies, 'merge-base', '--is-ancestor', remoteTip, 'HEAD');
  assert.equal(at(copies, 'rev-parse', 'origin/main'), remoteTip);
  assert.equal(await js(`Boolean(document.querySelector('.ref-tag.head .branch-sync-badge .lucide-arrow-up-from-line'))`), true, 'Outgoing commits stay visible on the current branch');
  await capture('copies-updated');

  // The first pull can discover new divergence. Its recovery card must lead to a working plan as well.
  const beforeRecovery = at(copies, 'rev-parse', 'HEAD');
  const previousRecoverCalls = recoverCalls;
  fs.writeFileSync(path.join(copiesWriter, 'local.txt'), 'remote edit');
  at(copiesWriter, 'add', 'local.txt');
  at(copiesWriter, 'commit', '-qm', 'edit the same file remotely');
  at(copiesWriter, 'push', '-q');
  await clickPull();
  const confirmPlan = '.plan-card .plan-actions .primary-button';
  const divergenceCard = '.recovery-card[data-kind="divergent"]';
  await waitFor(`document.querySelector('${confirmPlan}, ${divergenceCard}')`);
  await js(`document.querySelector('${confirmPlan}')?.click()`);
  await waitFor(`document.querySelector('${divergenceCard} .recovery-option')`);
  assert.equal(recoverCalls, previousRecoverCalls);
  await js(`document.querySelector('${divergenceCard} .recovery-option').click()`);
  await waitFor(`document.querySelector('${confirmPlan}')`);
  assert.equal(at(copies, 'rev-parse', 'HEAD'), beforeRecovery);
  await js(`document.querySelector('${confirmPlan}').click()`);
  await waitFor(`!document.querySelector('${confirmPlan}') && !document.querySelector('.branch-sync-badge.diverged')`);
  assert.equal(at(copies, 'rev-parse', 'HEAD^1'), beforeRecovery);
  assert.equal(at(copies, 'rev-parse', 'HEAD^2'), at(copiesWriter, 'rev-parse', 'HEAD'));
  assert.equal(at(copies, 'show', 'HEAD:local.txt'), 'remote edit');

  // A reply that arrives after a tab switch must leave the other project's request and draft alone.
  configured = true;
  fs.writeFileSync(path.join(repo, 'delivery-draft.txt'), 'changes in the first repository\n');
  fs.writeFileSync(path.join(copies, 'draft.txt'), 'changes in the second repository\n');
  await service.acknowledgeAiSharing(repo);
  await service.acknowledgeAiSharing(copies);
  const firstDraft = await service.getSnapshot(repo);
  const secondDraft = await service.getSnapshot(copies);
  restored = {
    projects: [firstDraft, secondDraft], unavailable: [],
    order: [firstDraft.path, secondDraft.path], activePath: firstDraft.path
  };
  const firstDescription = Promise.withResolvers();
  const secondDescription = Promise.withResolvers();
  descriptionGates.set(firstDraft.path, firstDescription.promise);
  descriptionGates.set(secondDraft.path, secondDescription.promise);
  const descriptionStart = described.length;
  const openDescription = async () => {
    await waitFor(`document.querySelector('.commit-row.wip[data-hash="working-tree"]')`);
    await js(`document.querySelector('.commit-row.wip[data-hash="working-tree"]').click()`);
    await waitFor(`document.querySelector('.commit-form-heading button:not(:disabled)')`);
    await js(`document.querySelector('.commit-form-heading button').click()`);
    await waitFor(`document.querySelector('#commit-description:disabled')`);
  };
  const waitForDescriptionRequest = async count => {
    for (let attempt = 0; attempt < 1200 && described.length < count; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(described.length, count);
  };
  await win.loadFile(path.join(root, 'dist/index.html'));
  await openDescription();
  await waitForDescriptionRequest(descriptionStart + 1);
  await js(`[...document.querySelectorAll('.window-tab [role="tab"]')].find(tab => tab.innerText === ${JSON.stringify(secondDraft.name)}).click()`);
  await waitFor(`document.querySelector('.window-tab.active')?.innerText === ${JSON.stringify(secondDraft.name)}`);
  await openDescription();
  await waitForDescriptionRequest(descriptionStart + 2);

  firstDescription.resolve('Description from the first tab');
  // Let the renderer receive the expired reply while the second request is still held.
  await js(`new Promise(resolve => setTimeout(resolve, 150))`);
  assert.equal(await js(`document.querySelector('#commit-description').disabled`), true, 'The first reply cannot clear the second tab’s pending state');
  assert.equal(await js(`document.querySelector('#commit-description').value`), '');
  secondDescription.resolve('Description from the second tab');
  await waitFor(`document.querySelector('#commit-description:not(:disabled)')?.value === 'Description from the second tab'`);

  if (process.platform === 'darwin') {
    const titleBar = `document.querySelector('.topbar')`;
    const style = `getComputedStyle(${titleBar})`;
    const normalInset = `${style}.paddingLeft === '88px'`;
    const fullscreenInset = `${titleBar} && ${style}.paddingLeft === ${style}.paddingRight`;
    assert.equal(await js(normalInset), true, 'The native controls have room in windowed mode');
    win.show();
    win.setFullScreen(true);
    await waitFor(fullscreenInset);
    assert.equal(win.isFullScreen(), true);
    await win.loadFile(path.join(root, 'dist/index.html'));
    await waitFor(fullscreenInset);
    win.setFullScreen(false);
    await waitFor(normalInset);
    assert.equal(win.isFullScreen(), false);
    console.log('PASS: the logo follows native macOS fullscreen state across entry, reload, and exit.');
  }

  win.destroy();
  console.log('PASS: worktree list, safe opening with separate edits and tree tab badges; unavailable saved project kept with retry, graph with work in progress, commit details, context menus, collapsible branch panel, compact layout, stable notifications, a work overview separating edited, saved, integrated and published work with one next step, readiness before a publish and the first save (Git, author, remote), a reviewed global identity written only to an isolated config, per-file include/exclude with selected diff and description, previewed .gitignore rule, AI sharing disclosure before the first description, reviewed save and integration, failed push recovered without the assistant, double-click checkout, background refresh, saving without secret warnings, guided conflict resolution without an assistant, fresh profile opening straight to projects with a guided AI connection (invalid key, unknown model, outage retry, unavailable secure storage), three ways to start with a start-tracking preview and first-save guidance, clone address checks, occupied destination, cancelled clone cleanup, and an empty cloned repository.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => clearTimeout(deadline));
