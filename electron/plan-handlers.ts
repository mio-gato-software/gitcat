import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ActionPlan, DeliveryRequest, Locale, OperationProgress } from "../shared/types.js";
import { executePlan, prepareBranchDelivery, prepareRetry, StalePlanError, type FailedPlanRecord } from "./git-service.js";
import { localized, normalizeLocale } from "./i18n.js";

type PlanHandlerDependencies = {
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  assertOpenedRepository: (path: unknown) => string;
  tracked: <T>(
    event: IpcMainInvokeEvent, path: string, phase: OperationProgress["phase"], task: () => Promise<T>,
    mutation?: boolean, onBusy?: "reject" | "wait"
  ) => Promise<T>;
};

export function createPlanHandlers({ assertTrustedSender, assertOpenedRepository, tracked }: PlanHandlerDependencies) {
  const issued = new Map<string, ActionPlan>();
  // Recovery reads what actually happened from the main process.
  const failed = new Map<string, FailedPlanRecord>();

  function rememberPlan(plan: ActionPlan) {
    if (plan.allowed && !plan.answer) {
      if (issued.size >= 100) issued.delete(issued.keys().next().value ?? "");
      issued.set(plan.id, plan);
    }
    return plan;
  }

  function rememberFailure(record: FailedPlanRecord) {
    if (failed.size >= 20) failed.delete(failed.keys().next().value ?? "");
    failed.set(record.plan.id, record);
  }

  function getFailure(planId: unknown) {
    return typeof planId === "string" ? failed.get(planId) : undefined;
  }

  function retainOpenedPlans(paths: readonly string[]) {
    for (const [id, plan] of issued) if (!paths.includes(plan.repoPath)) issued.delete(id);
  }

  function register(ipc: Pick<IpcMain, "handle">) {
    ipc.handle("action:prepare-delivery", async (event, cwd: unknown, input: unknown, locale?: Locale) => {
      assertTrustedSender(event);
      const request = input as DeliveryRequest;
      if (!request || typeof request.stateId !== "string" || typeof request.mergeToDefault !== "boolean"
          || (request.message !== undefined && typeof request.message !== "string")) {
        throw new Error("Invalid delivery request.");
      }
      // The service checks that each selected file still matches the version the user saw.
      if (request.selection !== undefined && (!Array.isArray(request.selection) || request.selection.length > 20_000
          || request.selection.some((item) => !item || typeof item.path !== "string" || !item.path || typeof item.version !== "string"))) {
        throw new Error("Invalid delivery request.");
      }
      const repoPath = assertOpenedRepository(cwd);
      const delivery: DeliveryRequest = {
        stateId: request.stateId,
        mergeToDefault: request.mergeToDefault,
        message: request.message,
        ...(request.selection ? { selection: request.selection.map(({ path, version }) => ({ path, version })) } : {})
      };
      return rememberPlan(await tracked(event, repoPath, "planning", () => prepareBranchDelivery(repoPath, delivery, locale)));
    });

    ipc.handle("action:prepare-retry", async (event, cwd: unknown, planId: unknown, locale?: Locale) => {
      assertTrustedSender(event);
      const repoPath = assertOpenedRepository(cwd);
      return tracked(event, repoPath, "planning", async () => {
        const record = getFailure(planId);
        if (!record || record.plan.repoPath !== repoPath) throw new Error(localized(normalizeLocale(locale),
          "Ese intento ya no está disponible. Revisa el resultado más reciente.",
          "That attempt is no longer available. Review the latest result."));
        const retry = await prepareRetry(repoPath, record, locale);
        return retry.allowed ? rememberPlan({ ...retry, retryOf: record.plan.id }) : retry;
      }, false, "wait");
    });

    ipc.handle("action:execute", async (event, cwd: unknown, planId: unknown, locale?: Locale) => {
      assertTrustedSender(event);
      const repoPath = assertOpenedRepository(cwd);
      const plan = typeof planId === "string" ? issued.get(planId) : undefined;
      if (!plan) throw new Error("El plan ya no es válido. Prepara la acción de nuevo.");
      if (plan.repoPath !== repoPath) throw new Error("El plan pertenece a otro repositorio.");
      issued.delete(plan.id);
      const previous = getFailure(plan.retryOf);
      if (plan.retryOf && !previous) throw new Error(localized(normalizeLocale(locale),
        "Ya se inició otra continuación para ese intento. Revisa el resultado más reciente.",
        "Another continuation already started for that attempt. Review the latest result."));
      // Claim the stopped attempt before waiting for execution. Any other review of it is obsolete.
      if (previous) failed.delete(previous.plan.id);
      const completedBefore = previous ? [
        ...(previous.completedBefore ?? []),
        ...previous.outcomes.filter(outcome => outcome.status === "completed").map(outcome => outcome.summary)
      ] : undefined;
      try {
        const result = await tracked(event, repoPath, "executing", () => executePlan(repoPath, plan, locale), true, "wait");
        if (result.error) {
          const { currentBranch, head } = result.snapshot;
          const progressed = result.outcomes.some(outcome => outcome.status === "completed");
          const resumeAt = progressed ? result.snapshotStale ? null : { currentBranch, head } : previous?.resumeAt;
          rememberFailure({ plan, outcomes: result.outcomes, stale: false, resumeAt, completedBefore });
        }
        return result;
      } catch (error) {
        // A thrown execution error happened before any step ran. Partial results are returned above.
        rememberFailure({
          plan,
          outcomes: plan.steps.map(({ command, summary }) => ({ command, summary, status: "skipped", output: "" })),
          stale: error instanceof StalePlanError,
          resumeAt: previous?.resumeAt,
          completedBefore
        });
        throw error;
      }
    });
  }

  return { register, rememberPlan, getFailure, retainOpenedPlans };
}
