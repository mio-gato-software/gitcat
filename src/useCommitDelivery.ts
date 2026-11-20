import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActionPlan, FileChange, Locale, RepoSnapshot, WithheldFile } from "../shared/types";
import type { Translate } from "./i18n";

type AttentionTarget = "form" | "description" | "selection" | "stale";
type DeliveryReview = { turnId: number; plan: ActionPlan };
type DeliveryOptions = {
  activeId?: string;
  snapshot?: RepoSnapshot;
  locale: Locale;
  t: Translate;
  busy: boolean;
  openForm: () => void;
  confirmSharing: (path: string, paths: string[]) => Promise<boolean>;
  reportDescriptionError: (path: string, error: unknown) => Promise<void>;
  showPlan: (question: string, load: () => Promise<ActionPlan>, path: string, options: { review: boolean }) => Promise<ActionPlan | undefined>;
};

export function useCommitDelivery({
  activeId, snapshot, locale, t, busy, openForm, confirmSharing, reportDescriptionError, showPlan
}: DeliveryOptions) {
  const [draft, setDraft] = useState("");
  const [suggestionKey, setSuggestionKey] = useState<string>();
  const [merge, setMerge] = useState(false);
  const [baseline, setBaseline] = useState<Record<string, string>>();
  const [attention, setAttention] = useState<{ path: string; target: AttentionTarget; sequence: number }>();
  const [excludedByRepo, setExcludedByRepo] = useState<Record<string, string[]>>({});
  const [review, setReview] = useState<DeliveryReview>();
  const [generating, setGenerating] = useState(false);
  const [withheld, setWithheld] = useState<WithheldFile[]>([]);
  const attentionSequence = useRef(0);
  const scope = useRef(0);
  const descriptionRequest = useRef<symbol | undefined>(undefined);

  const path = snapshot?.path;
  const excluded = useMemo(() => new Set(path ? excludedByRepo[path] ?? [] : []), [path, excludedByRepo]);
  const selected = useMemo(() => snapshot?.changes.filter((change) => !excluded.has(change.path)) ?? [], [snapshot, excluded]);
  const selectionKey = useMemo(() => JSON.stringify(selected.map(({ path, version }) => [path, version])), [selected]);
  const suggestionOutdated = suggestionKey !== undefined && suggestionKey !== selectionKey;
  const message = suggestionOutdated ? "" : draft;
  const latest = useRef({ selected, selectionKey, message });
  latest.current = { selected, selectionKey, message };
  const setMessage = (value: string) => {
    setDraft(value);
    setSuggestionKey(undefined);
    setWithheld([]);
  };
  // Only the ticked files matter. An edit to a file left out does not invalidate the review.
  const stale = Boolean(baseline && selected.some((change) => baseline[change.path] !== change.version));

  useLayoutEffect(() => {
    scope.current++;
    descriptionRequest.current = undefined;
    setMessage("");
    setMerge(false);
    setBaseline(undefined);
    setAttention(undefined);
    setReview(undefined);
    setGenerating(false);
    setWithheld([]);
  }, [activeId, path]);

  // Once a file leaves the list, a subsequent edit starts included again.
  useEffect(() => {
    if (!snapshot) return;
    const listed = new Set(snapshot.changes.map((change) => change.path));
    setExcludedByRepo((items) => {
      const saved = items[snapshot.path];
      if (!saved?.length) return items;
      const kept = saved.filter((file) => listed.has(file));
      return kept.length !== saved.length ? { ...items, [snapshot.path]: kept } : items;
    });
  }, [snapshot]);

  async function generateDescription() {
    const starting = latest.current;
    const paths = starting.selected.map((change) => change.path);
    if (!path || !paths.length || descriptionRequest.current) return;
    const request = Symbol();
    descriptionRequest.current = request;
    try {
      if (!(await confirmSharing(path, paths)) || descriptionRequest.current !== request
        || latest.current.selectionKey !== starting.selectionKey) return;
      setGenerating(true);
      const result = await window.gitcat.generateCommitDescription(path, locale, paths);
      if (descriptionRequest.current !== request || latest.current.selectionKey !== starting.selectionKey
        || latest.current.message !== starting.message) return;
      const ticked = new Map(latest.current.selected.map((change) => [change.path, change.version]));
      const described = result.selection ?? [];
      if (ticked.size === described.length && described.every((item) => ticked.get(item.path) === item.version)) {
        setDraft(result.description);
        setSuggestionKey(starting.selectionKey);
        setWithheld(result.withheld ?? []);
      }
    } catch (error) {
      if (descriptionRequest.current === request) await reportDescriptionError(path, error);
    } finally {
      if (descriptionRequest.current === request) {
        descriptionRequest.current = undefined;
        setGenerating(false);
      }
    }
  }

  const pointTo = (target: AttentionTarget) => {
    if (path) setAttention({ path, target, sequence: ++attentionSequence.current });
  };

  function prepareCommit(includeIntegration = merge) {
    if (!snapshot || busy || generating) return;
    if (stale) { pointTo("stale"); return; }
    if (!selected.length) { pointTo("selection"); return; }
    const trimmed = message.trim();
    if (!trimmed) { pointTo("description"); return; }
    if (trimmed.length > 120 || !snapshot.changes.length) return;
    const selection = selected.map((change) => ({ path: change.path, version: change.version ?? "" }));
    void showPlan(t(includeIntegration ? "saveAndIntegrate" : "saveChanges", { target: snapshot.defaultBranch ?? "" }),
      () => window.gitcat.prepareBranchDelivery(snapshot.path, { stateId: snapshot.stateId, message: trimmed, mergeToDefault: includeIntegration, selection }, locale),
      snapshot.path, { review: true });
  }

  function beginDelivery(integrate: boolean, refreshReview = false) {
    if (!snapshot || busy || generating) return;
    const continuing = baseline !== undefined && !refreshReview;
    const includeIntegration = continuing ? integrate || merge : integrate;
    setMerge(includeIntegration);
    if (!continuing) setBaseline(Object.fromEntries(snapshot.changes.map((change) => [change.path, change.version ?? ""])));
    if (snapshot.isDirty) {
      openForm();
      pointTo("form");
    } else if (integrate) {
      void showPlan(t("integrateInto", { target: snapshot.defaultBranch ?? "" }),
        () => window.gitcat.prepareBranchDelivery(snapshot.path, { stateId: snapshot.stateId, mergeToDefault: true }, locale),
        snapshot.path, { review: true });
    }
  }

  function toggleIncluded(file: FileChange) {
    if (!path) return;
    setExcludedByRepo((items) => {
      const current = items[path] ?? [];
      const next = current.includes(file.path) ? current.filter((item) => item !== file.path) : [...current, file.path];
      return { ...items, [path]: next };
    });
  }

  function setAllIncluded(include: boolean) {
    if (snapshot) setExcludedByRepo((items) => ({ ...items, [snapshot.path]: include ? [] : snapshot.changes.map((change) => change.path) }));
  }

  function clearDraftOnCommit(repoPath: string) {
    const startingScope = scope.current;
    return () => {
      if (path !== repoPath || startingScope !== scope.current) return;
      setMessage("");
      setBaseline(undefined);
      setWithheld([]);
    };
  }

  return {
    message, setMessage, merge, setMerge, stale, attention, excluded, selected, toggleIncluded, setAllIncluded,
    generating, generateDescription, suggestionOutdated, withheld: suggestionOutdated ? [] : withheld, review, setReview, prepareCommit, beginDelivery,
    clearDraftOnCommit,
    awaitingDecision: Boolean(review || generating || (snapshot?.isDirty && baseline && !stale))
  };
}
