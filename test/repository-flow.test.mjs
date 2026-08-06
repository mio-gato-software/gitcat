import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = await import(pathToFileURL(join(root, "dist-electron/electron/repository-plan.js")));
const llm = await import(pathToFileURL(join(root, "dist-electron/electron/llm-plan.js")));

const basePlan = {
  intent: "git_operation",
  operation: "status",
  args: { name: "", onto: "", message: "" },
  repository: { localPath: "", repository: "", owner: "", host: "", protocol: "", remote: "", push: true, replaceRemote: false },
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
  const plan = { ...basePlan, operation: "checkout", args: { name: "feature", onto: "main", message: "hola" } };
  assert.deepEqual(llm.operationArgs(plan), { name: "feature" });
  assert.deepEqual(llm.operationArgs({ ...plan, operation: "rebase" }), { onto: "main" });
  assert.deepEqual(llm.operationArgs({ ...plan, operation: "fetch" }), {});
});

test("una operación mal formada del modelo produce incidencias, no un plan", () => {
  assert.deepEqual(llm.operationIssues({ ...basePlan, operation: "status" }), []);
  const missingName = llm.operationIssues({ ...basePlan, operation: "checkout" });
  assert.equal(missingName.length, 1);
  assert.equal(missingName[0].field, "args.name");
  const unsafeName = llm.operationIssues({ ...basePlan, operation: "delete_branch", args: { ...basePlan.args, name: "--upload-pack=rm" } });
  assert.match(unsafeName[0].problem, /not a valid Git branch name/);
  const noBase = llm.operationIssues({ ...basePlan, operation: "rebase" });
  assert.equal(noBase[0].field, "args.onto");
  const longMessage = llm.operationIssues({ ...basePlan, operation: "commit", args: { ...basePlan.args, message: "x".repeat(121) } });
  assert.match(longMessage[0].problem, /the limit is 120/);
  assert.match(llm.operationIssues({ ...basePlan, operation: "none" })[0].problem, /cannot be executed/);
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
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, args: { name: 1, onto: "", message: "" } })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, intent: "delete_everything" })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, operation: "github_create_repo" })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, repository: { ...basePlan.repository, protocol: "ftp" } })), undefined);
  assert.equal(llm.parseModelPlan(JSON.stringify({ ...basePlan, repository: { ...basePlan.repository, push: "true" } })), undefined);
});
