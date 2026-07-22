import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { DEFAULT_GRAPH_VIEW, type GraphView } from "../lib/graph-viewport";

// Remember each run's graph pan/zoom so it survives leaving and returning to the Overview
// tab — that route unmounts when you switch to Stages/Files/etc. and remounts on return, so
// the viewport can't live only in component state. In-memory for the session; a full reload
// starts fresh. Tradeoff: unpruned Map, entries are three numbers each and a session views
// few runs — swap for an LRU if that ever stops holding.
const graphViewByRun = new Map<string, GraphView>();

const loadGraphView = (runId: string | undefined): GraphView =>
  (runId ? graphViewByRun.get(runId) : undefined) ?? DEFAULT_GRAPH_VIEW;

/**
 * Synchronizes a run's graph viewport with the session-scoped store above, so the
 * viewport is remembered per run across unmounts. `runId` controls which entry the
 * state binds to: when it changes, the returned view resets to that run's remembered
 * (or default) viewport instead of carrying the previous run's over. Every update is
 * written back to the store; the store itself needs no cleanup. Safe under Strict
 * Mode — the write is idempotent and re-runs persist the same committed value.
 */
export function useRememberedGraphView(
  runId: string | undefined,
): [GraphView, Dispatch<SetStateAction<GraphView>>] {
  const [view, setView] = useState<GraphView>(() => loadGraphView(runId));
  // Callers keep their component instance when only the route param changes, so the
  // rebind is a render-phase reset rather than a mount.
  const viewedRunId = useRef(runId);
  if (viewedRunId.current !== runId) {
    viewedRunId.current = runId;
    setView(loadGraphView(runId));
  }
  useEffect(() => {
    if (runId) graphViewByRun.set(runId, view);
  }, [runId, view]);
  return [view, setView];
}
