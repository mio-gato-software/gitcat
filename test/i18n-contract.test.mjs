import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("la interfaz tiene idioma persistente y un default derivado del sistema", async () => {
  const i18n = await readFile(join(root, "src/i18n.ts"), "utf8");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");

  assert.match(i18n, /export type Locale = "en" \| "es"/);
  assert.match(i18n, /const localeStorageKey = "gitcat-locale"/);
  assert.match(i18n, /navigator\.language\.toLowerCase\(\)\.startsWith\("es"\) \? "es" : "en"/);
  assert.match(i18n, /const es: \{ \[K in keyof typeof en\]: string \}/);
  assert.match(app, /useState<Locale>\(readLocale\)/);
  assert.match(app, /writeLocale\(next\)/);
  assert.match(app, /<select value=\{locale\}/);
  assert.match(app, /onLocaleChange=\{setLocale\}/);
});

test("el idioma elegido llega a los planes, la ejecución y los mensajes deterministas", async () => {
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const service = await readFile(join(root, "electron/git-service.ts"), "utf8");

  assert.match(app, /window\.gitcat\.planAction\(path, question, context, locale\)/);
  assert.match(app, /window\.gitcat\.executePlan\(plan\.repoPath, plan\.id, locale\)/);
  assert.match(preload, /planAction: \(path, request, context, locale\) => ipcRenderer\.invoke\("action:plan", path, request, context, locale\)/);
  assert.match(preload, /executePlan: \(path, planId, locale\) => ipcRenderer\.invoke\("action:execute", path, planId, locale\)/);
  assert.match(main, /ipcMain\.handle\("action:plan", async \(event, cwd: string, request: string, context\?: ConversationMessage\[\], locale\?: Locale\)/);
  assert.match(main, /ipcMain\.handle\("action:execute", async \(event, cwd: string, planId: string, locale\?: Locale\)/);
  assert.match(service, /import \{ localized, normalizeLocale \} from "\.\/i18n\.js"/);
  assert.match(service, /operationDraft\(operation: Operation, args: Record<string, string>, snapshot\?: RepoSnapshot, argv: string\[\] = \[\], locale: Locale = "es"\)/);
  assert.match(service, /There are no local changes to commit/);
  assert.match(service, /function failureReport\(outcomes: StepOutcome\[\], failed: StepOutcome, detail: string, snapshot: RepoSnapshot, locale\?: Locale\)/);
});
