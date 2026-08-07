import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = await import(pathToFileURL(join(root, "dist-electron/electron/repository-plan.js")));
const llm = await import(pathToFileURL(join(root, "dist-electron/electron/llm-plan.js")));

const noArgs = { name: "", onto: "", to: "", path: "", side: "", message: "" };
const step = (operation, args = {}) => ({ operation, args: { ...noArgs, ...args } });
const basePlan = {
  intent: "git_operation",
  steps: [step("status")],
  repository: { localPath: "", repository: "", owner: "", host: "", protocol: "", sshHost: "", remote: "", push: true, replaceRemote: false },
  summary: "Estado",
  rationale: "Consulta segura",
  reply: "",
  risk: "low"
};

test("el planificador acepta cualquier idioma y responde en el del usuario", async () => {
  const instructions = llm.buildPlannerInstructions({ openRepositoryPath: "/repo" });
  assert.match(instructions, /never by matching words or verb forms/);
  assert.match(instructions, /same language as the user's latest message/);
  assert.match(instructions, /"\/repo"/);
  assert.doesNotMatch(instructions, /Validation issues/);
});

test("los defectos vuelven al modelo como incidencias estructuradas", () => {
  const instructions = llm.buildPlannerInstructions({}, [{ field: "repository.host", problem: "missing" }]);
  assert.match(instructions, /Validation issues \(JSON\)/);
  assert.match(instructions, /"repository.host"/);
  assert.match(instructions, /use "needs_information"/);
});

test("solo llegan a Git los argumentos que la operación usa", () => {
  const args = { name: "feature", onto: "main", message: "hola" };
  assert.deepEqual(llm.operationArgs(step("checkout", args)), { name: "feature" });
  assert.deepEqual(llm.operationArgs(step("rebase", args)), { onto: "main" });
  assert.deepEqual(llm.operationArgs(step("fetch", args)), {});
});

test("una operación mal formada del modelo produce incidencias, no un plan", () => {
  assert.deepEqual(llm.operationIssues(step("status")), []);
  const missingName = llm.operationIssues(step("checkout"));
  assert.equal(missingName.length, 1);
  assert.equal(missingName[0].field, "steps[0].args.name");
  const unsafeName = llm.operationIssues(step("delete_branch", { name: "--upload-pack=rm" }));
  assert.match(unsafeName[0].problem, /not a valid Git branch name/);
  const noBase = llm.operationIssues(step("rebase"));
  assert.equal(noBase[0].field, "steps[0].args.onto");
  const longMessage = llm.operationIssues(step("commit", { message: "x".repeat(121) }));
  assert.match(longMessage[0].problem, /the limit is 120/);
  assert.match(llm.operationIssues(step("none"))[0].problem, /cannot be executed/);
});

test("la secuencia completa se valida, y cada incidencia señala su propio paso", () => {
  assert.deepEqual(llm.planIssues({ ...basePlan, steps: [step("checkout", { name: "main" }), step("merge", { name: "feature" })] }), []);
  const empty = llm.planIssues({ ...basePlan, steps: [] });
  assert.equal(empty[0].field, "steps");
  assert.match(empty[0].problem, /at least one step/);
  const secondBroken = llm.planIssues({ ...basePlan, steps: [step("checkout", { name: "main" }), step("merge")] });
  assert.equal(secondBroken.length, 1);
  assert.equal(secondBroken[0].field, "steps[1].args.name");
  const tooMany = llm.planIssues({ ...basePlan, steps: Array.from({ length: llm.planStepLimit + 1 }, () => step("fetch")) });
  assert.match(tooMany[0].problem, new RegExp(`the limit is ${llm.planStepLimit}`));
});

test("el esquema del plan acepta una secuencia y rechaza la forma antigua de un solo paso", () => {
  const parsed = llm.parseModelPlan(JSON.stringify({ ...basePlan, steps: [step("checkout", { name: "main" }), step("merge", { name: "feature" })] }));
  assert.equal(parsed.steps.length, 2);
  assert.equal(parsed.steps[1].operation, "merge");
  const legacy = { ...basePlan, operation: "checkout", args: noArgs };
  delete legacy.steps;
  assert.equal(llm.parseModelPlan(JSON.stringify(legacy)), undefined);
});

test("los nombres de rama peligrosos se rechazan", () => {
  for (const name of ["main", "feature/login", "release-1.2"]) assert.equal(llm.isBranchNameSafe(name), true);
  for (const name of ["", "-flag", ".hidden", "a..b", "a@{0}", "a//b", "end.lock", "trailing/"]) assert.equal(llm.isBranchNameSafe(name), false, name);
});

test("una ruta local nunca se convierte en propietario ni repositorio remoto", () => {
  const validation = repository.validateRepositoryFields({ localPath: "/mio-gato-software", protocol: "ssh" });
  assert.equal(validation.fields.localPath, "/mio-gato-software");
  assert.equal(validation.fields.owner, undefined);
  assert.equal(validation.fields.repository, undefined);
  assert.deepEqual(validation.issues.map((issue) => issue.field).sort(), ["host", "owner", "repository"]);
  for (const issue of validation.issues) assert.match(issue.problem, /^missing; expected the /);
});

test("las incidencias del repositorio son legibles para el modelo, no texto de interfaz", () => {
  const validation = repository.validateRepositoryFields({
    localPath: "relativa", owner: "-malo", host: "https://github.com/ruta", protocol: "ssh", repository: "algo.git"
  });
  assert.deepEqual(validation.issues.map((issue) => issue.field), ["localPath", "repository", "owner", "host"]);
  assert.match(validation.issues[0].problem, /"relativa" is not valid; expected the absolute path/);
  assert.match(validation.issues[1].problem, /never ".", ".." or ending in .git/);
  assert.match(validation.issues[3].problem, /DNS host name without scheme, port or path/);
});

test("normaliza y genera el esquema JSON exacto", () => {
  const plan = repository.buildRepositoryPlan({
    localPath: "/mio-gato-software/../mio-gato-software",
    repository: "mio-gato-software",
    owner: "eliaquin",
    host: "GITHUB.COM.",
    protocol: "ssh",
    push: true
  });
  assert.deepEqual(plan, {
    action: "create_repository_and_push",
    host: "github.com",
    owner: "eliaquin",
    repository: "mio-gato-software",
    localPath: "/mio-gato-software",
    protocol: "ssh",
    sshHost: "github.com",
    remoteUrl: "git@github.com:eliaquin/mio-gato-software.git",
    requiresConfirmation: true
  });
  assert.doesNotThrow(() => repository.assertRepositoryPlan(plan));
  assert.throws(() => repository.assertRepositoryPlan({ ...plan, extra: true }), /esquema/);
  assert.throws(() => repository.assertRepositoryPlan({ ...plan, remoteUrl: "git@github.com:otro/repo.git" }), /contenido/);
});

test("extrae JSON de markdown y repara solo cierres o comas seguros", () => {
  assert.deepEqual(llm.parseModelPlan(`Texto adicional\n\`\`\`json\n${JSON.stringify(basePlan)}\n\`\`\``), basePlan);
  const serialized = JSON.stringify(basePlan);
  assert.deepEqual(llm.parseModelPlan(serialized.replace(/\}$/, ",}")), basePlan);
  assert.deepEqual(llm.parseModelPlan(serialized.slice(0, -1)), basePlan);
});

test("rechaza planes LLM con esquema incompleto, campos extra o tipos incorrectos", () => {
  assert.equal(llm.parseModelPlan('{"intent":"git_operation","operation":"status"}'), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, command: "rm -rf /" })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, args: { name: 1, onto: "", to: "", path: "", side: "", message: "" } })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, intent: "delete_everything" })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, operation: "github_create_repo" })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, repository: { ...basePlan.repository, protocol: "ftp" } })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, repository: { ...basePlan.repository, push: "true" } })), undefined);
});

test("un alias de ssh_config llega a la URL del remoto; HTTPS nunca lo usa", () => {
  const base = { localPath: "/repo", repository: "gitcat", owner: "eliaquin", host: "github.com", push: true };
  const conAlias = repository.buildRepositoryPlan({ ...base, protocol: "ssh", sshHost: "github-personal" });
  assert.equal(conAlias.sshHost, "github-personal");
  assert.equal(conAlias.remoteUrl, "git@github-personal:eliaquin/gitcat.git");
  assert.doesNotThrow(() => repository.assertRepositoryPlan(conAlias));
  // Un plan manipulado para apuntar a otra identidad no sobrevive a la revalidación.
  assert.throws(() => repository.assertRepositoryPlan({ ...conAlias, sshHost: "github.com" }), /contenido/);

  const sinAlias = repository.buildRepositoryPlan({ ...base, protocol: "ssh" });
  assert.equal(sinAlias.remoteUrl, "git@github.com:eliaquin/gitcat.git");

  const https = repository.buildRepositoryPlan({ ...base, protocol: "https", sshHost: "github-personal" });
  assert.equal(https.sshHost, "");
  assert.equal(https.remoteUrl, "https://github.com/eliaquin/gitcat.git");
});

test("un alias SSH con forma inválida se reporta como incidencia", () => {
  const { issues } = repository.validateRepositoryFields({
    localPath: "/repo", repository: "gitcat", owner: "eliaquin", host: "github.com", protocol: "ssh", sshHost: "git@github.com:ruta"
  });
  assert.deepEqual(issues.map((issue) => issue.field), ["sshHost"]);
  assert.match(issues[0].problem, /SSH host name or ~\/.ssh\/config alias/);
});
