import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronStub = pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const service = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
const outbound = await import(pathToFileURL(join(root, "dist-electron/electron/outbound-content.js")));
const memory = await import(pathToFileURL(join(root, "dist-electron/electron/memory.js")));

// Obviously synthetic credentials. None of them may ever reach the provider, an error or a finding.
const AWS = "AKIAIOSFODNN7EXAMPLE";
const GITHUB = "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB";
const OPENAI = "sk-proj-SyntheticKey0123456789abcdefXYZ";
const PASSWORD = "Zq8vN3xR7tL2pW9k";
const PEM_BODY = "b3BlbnNzaC1rZXktdjEAAAAAsyntheticSYNTHETICsynthetic";
const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}\n-----END OPENSSH PRIVATE KEY-----\n`;
const EXCLUDED_TEXT = "internal-roadmap-do-not-share";
const secrets = [AWS, GITHUB, OPENAI, PASSWORD, PEM_BODY];

/** Stubbed Responses API: never a paid call. Each request consumes the next queued answer and is recorded. */
const queue = [];
const requests = [];
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  const next = queue.shift();
  if (next === undefined) throw new Error("llamada al proveedor no esperada");
  return { ok: true, status: 200, text: async () => "", json: async () => ({ status: "completed", output_text: typeof next === "string" ? next : JSON.stringify(next) }) };
};
queue.push("ok");
await service.saveLlmConfig({ apiKey: "sk-test", model: "test-model" });
test.beforeEach(() => { queue.length = 0; requests.length = 0; });

const step = (operation, args = {}, argv = []) => ({ operation, argv, args: { name: "", onto: "", to: "", path: "", side: "", message: "", noVerify: "", ...args } });
const plan = (overrides) => ({
  intent: "answer", steps: [],
  repository: { localPath: "", repository: "", owner: "", host: "", protocol: "", sshHost: "", remote: "", push: true, replaceRemote: false },
  summary: "s", rationale: "r", reply: "ok", risk: "low", ...overrides
});

/** Everything that left for the provider, as one string, so a leak anywhere in a request is caught. */
const sent = () => requests.map((request) => JSON.stringify(request)).join("\n");
function assertNoSecrets(text, where) {
  for (const secret of secrets) assert.equal(text.includes(secret), false, `${where} contains a synthetic secret`);
}

/**
 * A repository with one of everything: a tracked file that gains an AWS key, an untracked .env, an
 * untracked private key, an excluded folder, and an ordinary change the assistant may read.
 */
function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gitcat-sharing-")));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "config.js"), "export const region = 'eu-west-1';\n");
  writeFileSync(join(repo, "notes.md"), "notes\n");
  git("add", "-A"); git("commit", "-qm", "base");
  writeFileSync(join(repo, "config.js"), `export const region = 'eu-west-1';\nexport const accessKey = "${AWS}";\n`);
  writeFileSync(join(repo, "notes.md"), "notes\nordinary-visible-change\n");
  writeFileSync(join(repo, ".env"), `DATABASE_PASSWORD=${PASSWORD}\nOPENAI_API_KEY=${OPENAI}\n`);
  writeFileSync(join(repo, "id_ed25519"), PEM);
  mkdirSync(join(repo, "private"));
  writeFileSync(join(repo, "private", "plan.txt"), `${EXCLUDED_TEXT}\n`);
  return { repo, git };
}

test("the detector reports file, line and kind, never the value", () => {
  const findings = outbound.scanText("app.env", `ok=1\nAWS_KEY=${AWS}\nTOKEN: ${GITHUB}\n${PEM}\nDB_PASSWORD="${PASSWORD}"\nurl=postgres://me:${PASSWORD}@db\n`);
  assert.deepEqual(findings.map((finding) => [finding.line, finding.kind]), [
    [2, "aws_access_key"], [3, "github_token"], [4, "private_key"], [8, "secret_assignment"], [9, "credential_url"]
  ]);
  assertNoSecrets(JSON.stringify(findings), "findings");
  // Harmless code that merely mentions the words is left alone.
  assert.deepEqual(outbound.scanText("a.ts", "const password = getPassword();\nconst token: string = input;\napiKey: process.env.API_KEY\nPASSWORD=changeme\n"), []);
  // Credential files by name, and the ones that only count when their text carries a token.
  for (const path of [".env", "config/.env.production", "id_rsa", "deploy/server.pem", "keys/app.p12", "credentials.json"]) assert.equal(outbound.isCredentialFile(path), true, path);
  for (const path of [".env.example", "id_rsa.pub", "README.md", "src/env.ts"]) assert.equal(outbound.isCredentialFile(path), false, path);
  assert.equal(outbound.isCredentialFile(".npmrc", "registry=https://registry.npmjs.org/\n"), false);
  assert.equal(outbound.isCredentialFile(".npmrc", "//registry.npmjs.org/:_authToken=abc\n"), true);
  assert.equal(outbound.isCredentialFile("ca.pem", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"), false);
  // Free text keeps reading the same, with the credential replaced by a marker that names its kind.
  const redacted = outbound.redactText(`push failed for https://x:${PASSWORD}@example.test and ${GITHUB}`);
  assert.equal(redacted.redacted, 2);
  assertNoSecrets(redacted.text, "redacted text");
  assert.match(redacted.text, /\[withheld by GitCat: looks like a GitHub token\]/);
});

test("exclusions read like .gitignore patterns and are validated", () => {
  const cases = [
    ["private/", "private/plan.txt", true], ["private/", "src/private/x", true], ["private/", "private", false],
    ["*.sql", "db/dump.sql", true], ["*.sql", "db/dump.sqlite", false], ["config/prod.yml", "config/prod.yml", true],
    ["config/prod.yml", "other/config/prod.yml", false], ["docs/**/draft.md", "docs/a/b/draft.md", true], ["secrets", "app/secrets/key", true],
    ["/notes.md", "notes.md", true], ["/notes.md", "docs/notes.md", false], ["notes.md", "docs/notes.md", true]
  ];
  for (const [pattern, path, expected] of cases) assert.equal(outbound.matchesExclusion(path, pattern), expected, `${pattern} vs ${path}`);
  assert.equal(outbound.normalizeExclusion("  ./private/ "), "private/");
  assert.equal(outbound.normalizeExclusion("//notes.md"), "/notes.md");
  assert.equal(outbound.normalizeExclusion("/"), undefined);
  assert.equal(outbound.normalizeExclusion("../outside"), undefined);
  assert.equal(outbound.normalizeExclusion("a\nb"), undefined);
});

test("nothing is sent before the person agrees, and every entry point says so", async () => {
  const { repo } = fixture();
  const planned = await service.planAction(repo, "what changed?");
  assert.equal(planned.sharingRequired, true);
  assert.equal(planned.kind, "question");
  assert.match(planned.rationale, /No se envió nada/);
  const recovered = await service.planRecovery(repo, { command: "git push", summary: "Push", error: "rejected", skipped: [] }, [], "en");
  assert.equal(recovered.sharingRequired, true);
  assert.match(recovered.rationale, /Nothing was sent/);
  await assert.rejects(() => service.generateCommitDescription(repo, "en", ["notes.md"]), /Nothing was sent/);
  assert.equal(requests.length, 0, "no request leaves before the disclosure is accepted");

  // The preview is what the disclosure shows: every file this request would read, and its fate.
  await service.setAiSharingExclusions(repo, ["private/"]);
  const preview = await service.getAiSharing(repo, "planning");
  assert.equal(preview.acknowledged, false);
  assert.equal(preview.destination, "api.openai.com");
  const status = Object.fromEntries(preview.files.map((file) => [file.path, file.status]));
  assert.deepEqual(status, { "config.js": "likely_secret", "notes.md": "sent", ".env": "likely_secret", "id_ed25519": "likely_secret", "private/plan.txt": "excluded" });
  assert.deepEqual(preview.files.find((file) => file.path === "config.js").findings, [{ path: "config.js", line: 2, kind: "aws_access_key" }]);
  assertNoSecrets(JSON.stringify(preview), "preview");
  assert.equal(requests.length, 0);
});

test("planning sends placeholders for excluded and secret files and tells the planner and the person", async () => {
  const { repo } = fixture();
  await service.setAiSharingExclusions(repo, ["private/"]);
  await service.acknowledgeAiSharing(repo);
  queue.push(plan({ reply: "Only notes.md is readable." }));
  const context = [{ role: "user", content: `remember ${GITHUB}` }, { role: "assistant", content: "ok" }];
  const result = await service.planAction(repo, `explain my changes, my key is ${OPENAI}`, context, "en");
  assert.equal(result.answer, "Only notes.md is readable.");
  assert.equal(requests.length, 1);
  assertNoSecrets(sent(), "planning request");
  assert.equal(sent().includes(EXCLUDED_TEXT), false, "excluded content never leaves");
  const { instructions, input } = requests[0];
  assert.match(instructions, /ordinary-visible-change/, "readable changes still reach the planner");
  assert.match(instructions, /GitCat withheld the content of \.env: a local check found what looks like a credential/);
  assert.match(instructions, /GitCat withheld the content of private\/plan\.txt: the user excluded it/);
  assert.match(instructions, /"withheldFromModel"/);
  assert.match(instructions, /"redactedFromConversation": 2/);
  assert.match(instructions, /Never guess what a withheld file contains/);
  assert.match(JSON.stringify(input), /withheld by GitCat: looks like a GitHub token/);
  // The person is told the same: which files the answer could not read, and why.
  assert.deepEqual(result.withheld.map((file) => [file.path, file.reason]).sort(), [
    [".env", "likely_secret"], ["config.js", "likely_secret"], ["id_ed25519", "likely_secret"], ["private/plan.txt", "excluded"]
  ]);
  assertNoSecrets(JSON.stringify(result), "plan");
});

test("a planned commit filters outbound content without adding secret warnings to the save", async () => {
  const { repo } = fixture();
  await service.acknowledgeAiSharing(repo);
  queue.push(plan({ intent: "git_operation", steps: [step("commit")], summary: "Commit", rationale: "…", risk: "high", reply: "" }));
  queue.push("Update notes and configuration");
  const result = await service.planAction(repo, "commit everything", [], "en");
  assert.equal(requests.length, 2);
  assertNoSecrets(sent(), "commit description request");
  assert.match(requests[1].input, /GitCat withheld the content of id_ed25519/);
  assert.match(requests[1].input, /ordinary-visible-change/);
  assert.equal(result.allowed, true, result.rationale);
  assert.equal(result.secrets, undefined);
  assert.doesNotMatch(JSON.stringify(result.effects ?? []), /credential|secret/i);
  assertNoSecrets(JSON.stringify(result), "plan");
});

test("the save description reads only what may be shared, and says when it can read nothing", async () => {
  const { repo } = fixture();
  await service.acknowledgeAiSharing(repo);
  queue.push("Update notes");
  const result = await service.generateCommitDescription(repo, "en", ["notes.md", ".env"]);
  assert.equal(result.description, "Update notes");
  assert.deepEqual(result.withheld.map((file) => file.path), [".env"]);
  assertNoSecrets(sent(), "description request");
  assert.match(requests[0].input, /GitCat withheld the content of \.env/);
  assert.match(requests[0].instructions, /never guess\nor invent what a withheld file contains/);

  requests.length = 0;
  await assert.rejects(() => service.generateCommitDescription(repo, "en", [".env", "id_ed25519"]), /Write the description yourself/);
  assert.equal(requests.length, 0, "nothing readable means no request at all");
});

test("a reviewed file is shared at the version that was reviewed, and an edit asks again", async () => {
  const { repo } = fixture();
  await service.acknowledgeAiSharing(repo);
  await service.setAiSharingReview(repo, "config.js", true);
  const preview = await service.getAiSharing(repo, "planning");
  assert.equal(preview.files.find((file) => file.path === "config.js").status, "reviewed");
  queue.push("Add the access key");
  await service.generateCommitDescription(repo, "en", ["config.js"]);
  assert.match(requests[0].input, new RegExp(AWS), "the person chose to share this one");

  writeFileSync(join(repo, "config.js"), `export const accessKey = "${AWS}";\n// edited\n`);
  const again = await service.getAiSharing(repo, "planning");
  assert.equal(again.files.find((file) => file.path === "config.js").status, "likely_secret");
});

test("recovery redacts credentials that a failure printed", async () => {
  const { repo } = fixture();
  await service.acknowledgeAiSharing(repo);
  queue.push(plan({ intent: "needs_information", reply: "Check the remote credentials." }));
  const result = await service.planRecovery(repo, {
    command: `git push https://me:${PASSWORD}@example.test/repo.git`, summary: "Push",
    error: `remote: invalid token ${GITHUB}`, skipped: []
  }, [], "en");
  assert.equal(result.kind, "question");
  assertNoSecrets(sent(), "recovery request");
  assert.match(requests[0].instructions, /withheld by GitCat: looks like a GitHub token/);
  assert.match(requests[0].instructions, /GitCat withheld the content of \.env/);
});

test("conflict proposals never send excluded or secret files, and say why they were skipped", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gitcat-sharing-conflict-")));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  const files = { "app.txt": (side) => `${side}\n`, "settings.cfg": (side) => `mode=${side}\napi_token = "${GITHUB}"\n`, "private/doc.txt": (side) => `${EXCLUDED_TEXT} ${side}\n` };
  mkdirSync(join(repo, "private"));
  for (const [path, body] of Object.entries(files)) writeFileSync(join(repo, path), body("base"));
  git("add", "-A"); git("commit", "-qm", "base");
  git("switch", "-qc", "other");
  for (const [path, body] of Object.entries(files)) writeFileSync(join(repo, path), body("theirs"));
  git("commit", "-qam", "theirs");
  git("switch", "-q", "main");
  for (const [path, body] of Object.entries(files)) writeFileSync(join(repo, path), body("ours"));
  git("commit", "-qam", "ours");
  try { git("merge", "other"); } catch { /* the conflict is the point */ }

  await assert.rejects(() => service.proposeConflictResolution(repo, "en"), /Nothing was sent/);
  assert.equal(requests.length, 0);
  await service.setAiSharingExclusions(repo, ["private/"]);
  await service.acknowledgeAiSharing(repo);
  const preview = await service.getAiSharing(repo, "conflicts");
  assert.deepEqual(Object.fromEntries(preview.files.map((file) => [file.path, file.status])), { "app.txt": "sent", "private/doc.txt": "excluded", "settings.cfg": "likely_secret" });

  queue.push({ resolutions: [{ path: "app.txt", content: "merged\n", rationale: "both", confidence: "high" }], skipped: [] });
  const proposal = await service.proposeConflictResolution(repo, "en");
  assertNoSecrets(sent(), "conflict request");
  assert.equal(sent().includes(EXCLUDED_TEXT), false);
  assert.match(requests[0].input, /Path: app\.txt/);
  assert.doesNotMatch(requests[0].input, /settings\.cfg|private\/doc\.txt/);
  assert.deepEqual(proposal.resolutions.map((item) => item.path), ["app.txt"]);
  assert.match(proposal.skipped.find((item) => item.path === "settings.cfg").reason, /looks like it holds a credential \(settings\.cfg \(line \d+: GitHub token\)\)/);
  assert.match(proposal.skipped.find((item) => item.path === "private/doc.txt").reason, /excluded from what it may read/);
  assert.deepEqual(proposal.withheld.map((file) => file.path).sort(), ["private/doc.txt", "settings.cfg"]);
  assertNoSecrets(JSON.stringify(proposal.skipped), "skipped reasons");
});

for (const selectedOnly of [true, false]) {
  test(`saving credential-like files needs no secret review (${selectedOnly ? "selected" : "all"} files)`, async () => {
    const { repo, git } = fixture();
    const snapshot = await service.getSnapshot(repo);
    const selection = snapshot.changes.filter((change) => ["notes.md", ".env"].includes(change.path)).map((change) => ({ path: change.path, version: change.version }));
    const prepared = await service.prepareBranchDelivery(repo, {
      stateId: snapshot.stateId, mergeToDefault: false, message: "Save configuration",
      ...(selectedOnly ? { selection } : {})
    }, "en");
    assert.equal(prepared.kind, "plan");
    assert.equal(prepared.allowed, true, prepared.rationale);
    assert.equal(prepared.requiresConfirmation, true, "normal save confirmation still applies");
    assert.equal(prepared.secrets, undefined);
    assert.doesNotMatch(JSON.stringify(prepared.effects), /credential|secret/i);
    assert.equal(git("status", "--porcelain").includes("?? .env"), true, "preparing does not save anything");

    const diff = await service.getSelectionDiff(repo, ["config.js", "notes.md"], "en");
    assert.equal(diff.secrets, undefined);
    assert.ok(diff.diff.includes(AWS), "the local diff still shows the actual file contents");

    const result = await service.executePlan(repo, prepared, "en");
    assert.equal(result.error, undefined);
    assert.equal(result.outcomes[0].status, "completed");
    assert.equal(git("show", "HEAD:.env"), `DATABASE_PASSWORD=${PASSWORD}\nOPENAI_API_KEY=${OPENAI}\n`);
    assert.equal(git("status", "--porcelain").includes("config.js"), selectedOnly, "files left out remain unsaved");
    assert.equal(requests.length, 0, "manual saves do not contact the AI provider");
  });
}

test("removed credentials are still withheld from AI requests", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gitcat-sharing-removal-")));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "config.js"), `export const accessKey = "${AWS}";\n`);
  git("add", "-A"); git("commit", "-qm", "oops");
  writeFileSync(join(repo, "config.js"), "export const accessKey = process.env.ACCESS_KEY;\n");
  // It still leaves the Mac in the diff's removed line, so the assistant does not read it.
  assert.equal((await service.getAiSharing(repo, "planning")).files[0].status, "likely_secret");
});

test("output of a command aimed at a withheld file stays out of the conversation", async () => {
  const { repo, git } = fixture();
  git("add", ".env"); git("commit", "-qm", "add env");
  await service.acknowledgeAiSharing(repo);
  queue.push(plan({ intent: "git_operation", steps: [step("git_command", {}, ["show", "HEAD:.env"])], summary: "Show", reply: "" }));
  const reading = await service.planAction(repo, "show me .env", [], "en");
  assert.equal(reading.requiresConfirmation, false);
  const execution = await service.executePlan(repo, reading, "en");
  assert.equal(execution.withheldFromAssistant, true);
  queue.push(plan({ intent: "git_operation", steps: [step("git_command", {}, ["log", "-1", "--format=%s"])], summary: "Log", reply: "" }));
  const harmless = await service.executePlan(repo, await service.planAction(repo, "last subject", [], "en"), "en");
  assert.equal(harmless.withheldFromAssistant, undefined);
});

test("sharing choices are remembered per repository, sanitized and moved with the project", () => {
  const now = "2026-09-01T00:00:00.000Z";
  const remembered = memory.rememberSharing(memory.emptyMemory(), "/repo", { acknowledgedAt: now, exclusions: ["private/"] }, now);
  assert.deepEqual(memory.recallSharing(remembered, "/repo").exclusions, ["private/"]);
  assert.equal(memory.recallSharing(remembered, "/other").acknowledgedAt, undefined, "another repository asks again");
  const clean = memory.sanitizeMemory({ sharing: {
    "/repo": { acknowledgedAt: now, exclusions: ["ok/", 5, "bad\nline"], reviewed: { "a.txt": "abcdef0123456789abcdef", "b.txt": "not a version" }, confirmedAt: now },
    "/empty": { exclusions: [] }
  } });
  assert.deepEqual(Object.keys(clean.sharing), ["/repo"]);
  assert.deepEqual(clean.sharing["/repo"].exclusions, ["ok/"]);
  assert.deepEqual(Object.keys(clean.sharing["/repo"].reviewed), ["a.txt"]);
  const moved = memory.relocateRepository(remembered, "/repo", "/moved");
  assert.equal(memory.recallSharing(moved, "/moved").acknowledgedAt, now);
  assert.equal(moved.sharing["/repo"], undefined);
});

test("the interface asks before the first content-bearing request and keeps the manual save path", async () => {
  const { readFile } = await import("./helpers/source.mjs");
  const app = await readFile(join(root, "src/App.tsx"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  // Every entry point that reads repository content goes through the same question first.
  assert.match(app, /if \(!\(await ensureSharing\(path, "planning"\)\)\) \{ setRequest\(question\); return; \}/);
  assert.match(app, /if \(!\(await ensureSharing\(path, "recovery"\)\)\)/);
  assert.match(app, /if \(!\(await ensureSharing\(snapshot\.path, "conflicts"\)\)\) return;/);
  assert.match(app, /if \(!\(await ensureSharing\(repoPath, "description", paths\)\)\) return;/);
  // Opening the save flow only writes a description on its own once sharing was agreed.
  assert.match(app, /void sharingAgreed\(path\)\.then\(\(agreed\) => \{ if \(agreed/);
  // Manual saves require a description but no heuristic secret review.
  assert.doesNotMatch(app, /secret-warning|secretBadge|secretsReviewed|scanChangesForSecrets/);
  assert.doesNotMatch(main + preload, /changes:scan-secrets|scanChangesForSecrets/);
  assert.match(app, /if \(!message\) \{ pointTo\("description"\); return; \}/);
  assert.match(app, /t\("secretDetectorLimits"\)/);
  assert.match(app, /turn\.private && \(turn\.error \|\| turn\.outcome\) \? privateOutputNote/);
  for (const channel of ["sharing:get", "sharing:acknowledge", "sharing:set-exclusions", "sharing:review"]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}", \\(event[^)]*\\) => \\{\\n    assertTrustedSender\\(event\\);`));
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\("${channel}"`));
  }
});
