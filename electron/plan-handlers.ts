import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ActionPlan, DeliveryRequest, Locale, OperationProgress } from "../shared/types.js";
import { executePlan, prepareBranchDelivery, StalePlanError, type FailedPlanRecord } from "./git-service.js";

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

    ipc.handle("action:execute", async (event, cwd: unknown, planId: unknown, locale?: Locale) => {
      assertTrustedSender(event);
      const repoPath = assertOpenedRepository(cwd);
      const plan = typeof planId === "string" ? issued.get(planId) : undefined;
      if (!plan) throw new Error("El plan ya no es válido. Prepara la acción de nuevo.");
      issued.delete(plan.id);
      if (plan.repoPath !== repoPath) throw new Error("El plan pertenece a otro repositorio.");
      try {
        const result = await tracked(event, repoPath, "executing", () => executePlan(repoPath, plan, locale), true, "wait");
        if (result.error) rememberFailure({ plan, outcomes: result.outcomes, stale: false });
        return result;
      } catch (error) {
        // A thrown execution error happened before any step ran. Partial results are returned above.
        rememberFailure({
          plan,
          outcomes: plan.steps.map(({ command, summary }) => ({ command, summary, status: "skipped", output: "" })),
          stale: error instanceof StalePlanError
        });
        throw error;
      }
    });
  }

  return { register, rememberPlan, getFailure, retainOpenedPlans };
}
