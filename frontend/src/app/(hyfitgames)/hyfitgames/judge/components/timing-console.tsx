"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  colorChoices,
  cognitiveSequenceLength,
  generateCognitiveSequence,
  validCognitiveSequence,
  type ColorKey,
} from "../lib/cognitive-sequence";
import {
  allowsBearCrawlPenalty,
  formatRaceTime,
  raceStage,
  raceStages,
  type StationOutcome,
} from "../lib/race-format";
import type { Participant } from "../lib/participants";
import { isDoublesContestId } from "../lib/doubles";
import MobileActionDock from "./mobile-action-dock";

type Split = {
  id: string;
  operationKey?: string;
  stageId: string;
  stageName: string;
  boundaryAt: string;
  cumulativeMs: string | number;
  segmentMs: string | number;
};

type TimingSnapshot = {
  session: {
    id: string;
    bib: string;
    participantName: string;
    currentStage: string;
    manualStartedAt: string | null;
    cognitiveRecallStartedAt: string | null;
    isOoc: boolean;
    state: string;
    raceMode: "single" | "doubles";
    cognitiveSequence: ColorKey[];
    athleteNote: string;
  };
  participants: Participant[];
  splits: Split[];
  outcomes: Array<{
    stationNumber: number;
    outcome: StationOutcome;
    penaltySeconds: number;
    note: string;
    operationKey?: string;
  }>;
  cognitive: null | {
    response: ColorKey[];
    correctCount: number;
    percentage: number;
    penaltySeconds: number;
    bonusSeconds: number;
    recallDurationMs: string | number;
  };
  delivery: Array<{
    bib: string;
    total: number;
    confirmed: number;
    attention: number;
  }>;
  finalSegments: {
    tyreFlipRecallMs: number | null;
    recallToFinishMs: number | null;
    recallCompletedAt: string | null;
  };
  latestAction: null | {
    operationId: string;
    action: string;
    stageId: string;
    payload: Record<string, unknown>;
    beforeState: Record<string, unknown>;
    sequence: number;
    reversible: boolean;
  };
  revision: number;
  restoredRecallDraft?: null | {
    response: ColorKey[];
    tapObservedAt: string[];
  };
};

type TimingAction = Record<string, unknown> & {
  action: string;
  operationId: string;
  bib: string;
  clientObservedAt: string;
};

function newOperationId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function numeric(value: string | number | undefined) {
  return Number(value ?? 0);
}

type LocalTimingRecord = {
  version: 1;
  snapshot: TimingSnapshot;
  recall: ColorKey[];
  tapObservedAt: string[];
};

const localTimingKey = (bib: string) => `hyfit-timing-v1:${bib}`;

/**
 * A new race, built on the tablet.
 *
 * This used to arrive from the server, which owned the race session. Nothing
 * owns it now but this device, so the starting shape — including the cognitive
 * sequence the athlete will be asked to recall — is made here.
 */
function createSnapshot(
  athlete: Participant,
  teammate?: Participant,
): TimingSnapshot {
  const doubles = isDoublesContestId(athlete.contestId) && Boolean(teammate);
  return {
    session: {
      id: newOperationId(),
      bib: athlete.bib,
      participantName: athlete.name,
      currentStage: "ready",
      manualStartedAt: null,
      cognitiveRecallStartedAt: null,
      isOoc: false,
      state: "active",
      raceMode: doubles ? "doubles" : "single",
      cognitiveSequence: generateCognitiveSequence(),
      athleteNote: "",
    },
    participants: [athlete, ...(doubles && teammate ? [teammate] : [])],
    splits: [],
    outcomes: [],
    cognitive: null,
    delivery: [],
    finalSegments: {
      tyreFlipRecallMs: null,
      recallToFinishMs: null,
      recallCompletedAt: null,
    },
    latestAction: null,
    revision: 0,
    restoredRecallDraft: null,
  };
}

function readLocalTiming(bib: string): LocalTimingRecord | null {
  try {
    const value = localStorage.getItem(localTimingKey(bib));
    return value ? (JSON.parse(value) as LocalTimingRecord) : null;
  } catch {
    return null;
  }
}

function writeLocalTiming(bib: string, record: LocalTimingRecord) {
  localStorage.setItem(localTimingKey(bib), JSON.stringify(record));
}

function projectTiming(
  snapshot: TimingSnapshot,
  action: TimingAction,
): TimingSnapshot {
  const next = JSON.parse(JSON.stringify(snapshot)) as TimingSnapshot;
  const observedAt = action.clientObservedAt;
  const currentStage = raceStage(snapshot.session.currentStage);
  const beforeState = {
    currentStage: snapshot.session.currentStage,
    state: snapshot.session.state,
    manualStartedAt: snapshot.session.manualStartedAt,
    cognitiveRecallStartedAt: snapshot.session.cognitiveRecallStartedAt,
    isOoc: snapshot.session.isOoc,
    finishedAt: null,
    lastActionKey: snapshot.latestAction?.operationId ?? null,
    latestAction: snapshot.latestAction,
  };
  if (action.action === "undo_last_action" && snapshot.latestAction) {
    const restore = snapshot.latestAction.beforeState;
    next.session.currentStage = String(restore.currentStage ?? "ready");
    next.session.state = String(restore.state ?? "active");
    next.session.manualStartedAt =
      (restore.manualStartedAt as string | null) ?? null;
    next.session.cognitiveRecallStartedAt =
      (restore.cognitiveRecallStartedAt as string | null) ?? null;
    next.session.isOoc = Boolean(restore.isOoc);
    next.splits = next.splits.filter(
      (split) => split.operationKey !== action.targetOperationId,
    );
    next.outcomes = next.outcomes.filter(
      (item) => item.operationKey !== action.targetOperationId,
    );
    if (snapshot.latestAction.action === "complete_recall")
      next.cognitive = null;
    next.restoredRecallDraft =
      snapshot.latestAction.action === "complete_recall"
        ? {
            response: (snapshot.latestAction.payload.response ??
              []) as ColorKey[],
            tapObservedAt: (snapshot.latestAction.payload.tapObservedAt ??
              []) as string[],
          }
        : null;
    next.latestAction = (restore.latestAction ??
      null) as TimingSnapshot["latestAction"];
    return next;
  }
  if (action.action === "update_athlete_note") {
    next.session.athleteNote = String(action.note ?? "").slice(0, 1000);
    next.revision += 1;
    return next;
  }
  if (!currentStage) return next;
  const startedAt = snapshot.session.manualStartedAt ?? observedAt;
  const previousBoundary = snapshot.splits.at(-1)?.boundaryAt ?? startedAt;
  const boundary = new Date(observedAt).getTime();
  next.splits.push({
    id: action.operationId,
    operationKey: action.operationId,
    stageId: currentStage.id,
    stageName: currentStage.name,
    boundaryAt: observedAt,
    cumulativeMs: Math.max(0, boundary - new Date(startedAt).getTime()),
    segmentMs: Math.max(0, boundary - new Date(previousBoundary).getTime()),
  });
  if (action.action === "start") {
    next.session.currentStage = "cognitive_memorise";
    if (snapshot.session.raceMode === "single")
      next.session.manualStartedAt = observedAt;
  } else if (action.action === "memorise_complete") {
    next.session.currentStage =
      snapshot.session.raceMode === "doubles" ? "team_start" : "run_1";
  } else if (action.action === "team_start") {
    next.session.currentStage = "run_1";
    next.session.manualStartedAt = observedAt;
  } else if (action.action === "complete_stage") {
    next.session.currentStage =
      currentStage.nextId ?? snapshot.session.currentStage;
    if (action.outcome === "ics") next.session.isOoc = true;
    if (currentStage.kind === "station") {
      next.outcomes.push({
        stationNumber: currentStage.stationNumber ?? 0,
        outcome: String(action.outcome ?? "none") as StationOutcome,
        penaltySeconds: Number(action.penaltySeconds ?? 0),
        note: String(action.note ?? ""),
        operationKey: action.operationId,
      });
    }
  } else if (action.action === "complete_recall") {
    next.session.currentStage = "finish_approach";
  } else if (action.action === "finish") {
    next.session.currentStage = "complete";
    next.session.state = "finished";
  }
  next.latestAction = {
    operationId: action.operationId,
    action: action.action,
    stageId: currentStage.id,
    payload: action,
    beforeState,
    sequence: snapshot.revision + 1,
    reversible: true,
  };
  next.revision += 1;
  return next;
}

export default function TimingConsole({
  athlete,
  teammate,
  onJudgeNextAthlete,
}: {
  athlete: Participant;
  teammate?: Participant;
  onJudgeNextAthlete: () => void;
}) {
  const [snapshot, setSnapshot] = useState<TimingSnapshot | null>(null);
  const cognitiveSequence = validCognitiveSequence(
    snapshot?.session.cognitiveSequence,
  )
    ? snapshot.session.cognitiveSequence
    : [];
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const [outcome, setOutcome] = useState<StationOutcome>("none");
  const [noteOpen, setNoteOpen] = useState(false);
  const [recall, setRecall] = useState<ColorKey[]>([]);
  const [recallSubmitting, setRecallSubmitting] = useState(false);
  // Whether RaceResult has this race. Only meaningful once it is finished:
  // until then there is nothing to send.
  const [sent, setSent] = useState(false);
  const recallLocked = useRef(false);
  const recallRef = useRef<ColorKey[]>([]);
  const tapTimesRef = useRef<string[]>([]);
  const snapshotRef = useRef<TimingSnapshot | null>(null);
  const noteTimerRef = useRef<number | null>(null);
  const noteDraftRef = useRef("");
  const lastQueuedNoteRef = useRef("");

  const persist = useCallback(
    (nextSnapshot: TimingSnapshot) => {
      writeLocalTiming(athlete.bib, {
        version: 1,
        snapshot: nextSnapshot,
        recall: recallRef.current,
        tapObservedAt: tapTimesRef.current,
      });
    },
    [athlete.bib],
  );

  const adoptSnapshot = useCallback((nextSnapshot: TimingSnapshot) => {
    nextSnapshot.session.athleteNote ??= "";
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
    if (nextSnapshot.restoredRecallDraft) {
      recallRef.current = nextSnapshot.restoredRecallDraft.response;
      tapTimesRef.current = nextSnapshot.restoredRecallDraft.tapObservedAt;
      setRecall(nextSnapshot.restoredRecallDraft.response);
    }
  }, []);

  /**
   * Hands the finished race to RaceResult.
   *
   * The only time this console talks to the server. Everything before it is
   * local: the race is not stored anywhere, so there is nothing to keep in step
   * with and nothing to reconcile against. Safe to repeat — every field is set
   * rather than appended, so re-sending repairs a half-delivered race instead
   * of double-counting it.
   */
  const submitRace = useCallback(
    async (finished: TimingSnapshot) => {
      const bibs = finished.participants?.length
        ? finished.participants.map((person) => person.bib)
        : [athlete.bib];

      const response = await fetch("/api/hyfit-judge/judge/results", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bibs,
          raceMode: finished.session.raceMode,
          contestId: athlete.contestId,
          boundaries: finished.splits.map((split) => ({
            stageId: split.stageId,
            boundaryAt: split.boundaryAt,
          })),
          stationOutcomes: finished.outcomes.map((item) => ({
            stationNumber: item.stationNumber,
            outcome: item.outcome,
            penaltySeconds: item.penaltySeconds,
            note: item.note,
          })),
          cognitive: finished.cognitive
            ? {
                sequence: finished.session.cognitiveSequence,
                response: finished.cognitive.response,
              }
            : undefined,
          athleteNote: finished.session.athleteNote ?? "",
          status: finished.session.isOoc ? "DNF" : "FIN",
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          data.error ?? data.message ?? "RaceResult did not accept the race",
        );
    },
    [athlete.bib, athlete.contestId],
  );

  /** Sends the finished race, and says plainly when it did not land. */
  const deliver = useCallback(
    async (finished: TimingSnapshot | null) => {
      if (!finished) return;
      setBusy(true);
      try {
        await submitRace(finished);
        setSent(true);
        setError("");
      } catch (sendError) {
        setSent(false);
        setError(
          `${(sendError as Error).message} · the race is held on this tablet`,
        );
      } finally {
        setBusy(false);
      }
    },
    [submitRace],
  );

  /**
   * The race, restored or started.
   *
   * There is no server copy to fetch: this tablet is the only place the race
   * exists until it is submitted. A reload finds it in localStorage; anything
   * else starts a new one.
   */
  const load = useCallback(async () => {
    const local = readLocalTiming(athlete.bib);
    if (local?.version === 1) {
      recallRef.current = local.recall;
      tapTimesRef.current = local.tapObservedAt;
      setRecall(local.recall);
      adoptSnapshot(local.snapshot);
      return;
    }
    const fresh = createSnapshot(athlete, teammate);
    adoptSnapshot(fresh);
    persist(fresh);
  }, [adoptSnapshot, athlete, teammate, persist]);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      setLoading(true);
      void load()
        .catch((loadError) => setError((loadError as Error).message))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(restore);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  // A finished race that never reached RaceResult is worth another try the
  // moment the tablet is back on the network.
  useEffect(() => {
    const retry = () => {
      if (snapshotRef.current?.session.state === "finished" && !sent)
        void deliver(snapshotRef.current);
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [deliver, sent]);

  useEffect(
    () => () => {
      if (noteTimerRef.current != null)
        window.clearTimeout(noteTimerRef.current);
    },
    [],
  );

  const stage = raceStage(snapshot?.session.currentStage ?? "ready");
  const lastSplit = snapshot?.splits.at(-1);
  const startMs = snapshot?.session.manualStartedAt
    ? new Date(snapshot.session.manualStartedAt).getTime()
    : null;
  const lastBoundaryMs = lastSplit
    ? new Date(lastSplit.boundaryAt).getTime()
    : startMs;
  const totalMs = startMs
    ? snapshot?.session.state === "finished" && lastSplit
      ? numeric(lastSplit.cumulativeMs)
      : now - startMs
    : 0;
  const stageMs =
    snapshot?.session.state === "finished" && lastSplit
      ? numeric(lastSplit.segmentMs)
      : lastBoundaryMs && startMs
        ? now - lastBoundaryMs
        : 0;

  async function act(extra: Record<string, unknown>) {
    if (busy || !snapshotRef.current) return false;
    setBusy(true);
    setError("");
    const body: TimingAction = {
      action: String(extra.action),
      operationId: newOperationId(),
      bib: athlete.bib,
      clientObservedAt: new Date().toISOString(),
      ...extra,
    };
    try {
      const next = projectTiming(snapshotRef.current, body);
      persist(next);
      adoptSnapshot(next);
      setBusy(false);
      return true;
    } catch {
      setError("Timing was not saved on this tablet · tap again");
      setBusy(false);
      return false;
    }
  }

  async function completeCurrentStage() {
    if (!stage || !["run", "station"].includes(stage.kind)) return;
    const result = await act({
      action: "complete_stage",
      stageId: stage.id,
      outcome: stage.kind === "station" ? outcome : "none",
      penaltySeconds:
        stage.stationNumber === 3 &&
        outcome === "penalty" &&
        allowsBearCrawlPenalty(athlete.contestId)
          ? 10
          : 0,
      note: "",
    });
    if (result) {
      setOutcome("none");
    }
  }

  async function flushAthleteNote() {
    if (noteTimerRef.current != null) {
      window.clearTimeout(noteTimerRef.current);
      noteTimerRef.current = null;
    }
    const value = noteDraftRef.current.trim();
    if (value === lastQueuedNoteRef.current) return true;
    const accepted = await act({ action: "update_athlete_note", note: value });
    if (accepted) lastQueuedNoteRef.current = value;
    return accepted;
  }

  function updateAthleteNote(value: string) {
    const limited = value.slice(0, 1000);
    noteDraftRef.current = limited;
    if (snapshotRef.current) {
      const next = JSON.parse(
        JSON.stringify(snapshotRef.current),
      ) as TimingSnapshot;
      next.session.athleteNote = limited;
      adoptSnapshot(next);
      persist(next);
    }
    if (noteTimerRef.current != null) window.clearTimeout(noteTimerRef.current);
    noteTimerRef.current = window.setTimeout(
      () => void flushAthleteNote(),
      600,
    );
  }

  async function finishRace() {
    if (!(await flushAthleteNote())) return;
    if (!(await act({ action: "finish" }))) return;
    await deliver(snapshotRef.current);
  }

  async function tapColour(color: ColorKey) {
    if (
      busy ||
      recallLocked.current ||
      recallRef.current.length >= cognitiveSequenceLength
    )
      return;
    const tappedAt = new Date().toISOString();
    const nextRecall = [...recallRef.current, color];
    const nextTimes = [...tapTimesRef.current, tappedAt];
    recallRef.current = nextRecall;
    tapTimesRef.current = nextTimes;
    setRecall(nextRecall);
    if (snapshotRef.current) persist(snapshotRef.current);
  }

  function undoColour() {
    if (!recallRef.current.length) return;
    recallRef.current = recallRef.current.slice(0, -1);
    tapTimesRef.current = tapTimesRef.current.slice(0, -1);
    setRecall(recallRef.current);
    if (snapshotRef.current) persist(snapshotRef.current);
  }

  function resetRecall() {
    recallRef.current = [];
    tapTimesRef.current = [];
    setRecall([]);
    if (snapshotRef.current) persist(snapshotRef.current);
  }

  async function completeRecall() {
    if (
      busy ||
      recallLocked.current ||
      recallRef.current.length !== cognitiveSequenceLength ||
      cognitiveSequence.length !== cognitiveSequenceLength
    )
      return;
    recallLocked.current = true;
    setRecallSubmitting(true);
    const result = await act({
      action: "complete_recall",
      response: recallRef.current,
      tapObservedAt: tapTimesRef.current,
      clientObservedAt: new Date().toISOString(),
    });
    if (!result) recallLocked.current = false;
    setRecallSubmitting(false);
  }

  function undoLabel(action: NonNullable<TimingSnapshot["latestAction"]>) {
    if (action.action === "finish") return "Finish";
    if (action.action === "complete_recall") return "Cognitive Recall";
    if (action.action === "memorise_complete") return "Memorisation";
    if (action.action === "team_start") return "Team Start";
    if (action.action === "start") return "Show Colours";
    return raceStage(action.stageId)?.name ?? "last action";
  }

  async function undoLastAction() {
    const latest = snapshotRef.current?.latestAction;
    if (!latest) return;
    const needsConfirmation =
      latest.action === "finish" ||
      latest.action === "complete_recall" ||
      latest.payload.outcome === "ics";
    if (
      needsConfirmation &&
      !window.confirm(
        `Undo ${undoLabel(latest)}? The race will move back exactly one step.`,
      )
    )
      return;
    await act({
      action: "undo_last_action",
      targetOperationId: latest.operationId,
    });
  }

  const courseIndex = useMemo(
    () => raceStages.findIndex((item) => item.id === stage?.id),
    [stage?.id],
  );

  if (loading) {
    return (
      <section className="timing-console timing-loading">
        <b>Loading race timing…</b>
        <span>Keep this screen open.</span>
      </section>
    );
  }
  if (!snapshot || !stage) {
    return (
      <section className="timing-console timing-error">
        <b>Race timing is unavailable</b>
        <span>{error}</span>
        <button className="timing-primary" onClick={() => void load()}>
          Try again
        </button>
      </section>
    );
  }

  const isComplete = stage.kind === "complete";
  const doubles =
    snapshot.session.raceMode === "doubles" ||
    isDoublesContestId(athlete.contestId);
  const teamAthletes = snapshot.participants?.length
    ? snapshot.participants
    : [athlete, ...(teammate ? [teammate] : [])];
  const undoControl =
    snapshot.latestAction && stage.kind !== "recall" ? (
      <button
        className="timing-undo"
        disabled={busy}
        onClick={() => void undoLastAction()}
      >
        ↶ Undo · {undoLabel(snapshot.latestAction)}
      </button>
    ) : null;
  const judgeNext = () => {
    localStorage.removeItem(localTimingKey(athlete.bib));
    onJudgeNextAthlete();
  };
  return (
    <section
      className={`timing-console${snapshot.session.isOoc ? " is-ooc" : ""}`}
    >
      <header className="timing-athlete-rail">
        <div>
          <small>{doubles ? "ACTIVE DOUBLES TEAM" : "ACTIVE ATHLETE"}</small>
          <strong>
            {teamAthletes.map((participant) => participant.name).join(" + ")}
          </strong>
          <span>
            {athlete.category || "HYFIT athlete"}
            {doubles && athlete.club ? ` · ${athlete.club}` : ""}
          </span>
        </div>
        <div className="timing-bib">
          <small>{doubles ? "BIBS" : "BIB"}</small>
          <b>
            {teamAthletes.map((participant) => participant.bib).join(" · ")}
          </b>
        </div>
        <div className="timing-clock">
          <small>{doubles ? "TEAM TIME" : "TOTAL TIME"}</small>
          <b>{formatRaceTime(totalMs)}</b>
          <span>
            {startMs
              ? doubles
                ? "First start recorded"
                : "Running from Show Colours"
              : doubles
                ? "Starts with first partner"
                : "Starts with Show Colours"}
          </span>
        </div>
      </header>

      {isComplete ? (
        <section className="athlete-note-readonly">
          <small>ATHLETE NOTE · READ ONLY</small>
          <p>
            {snapshot.session.athleteNote?.trim() || "No athlete note added."}
          </p>
        </section>
      ) : (
        <button
          className={`athlete-note-chip${snapshot.session.athleteNote?.trim() ? " has-note" : ""}`}
          onClick={() => {
            noteDraftRef.current = snapshot.session.athleteNote ?? "";
            lastQueuedNoteRef.current = snapshot.session.athleteNote ?? "";
            setNoteOpen(true);
          }}
        >
          ✎ {snapshot.session.athleteNote?.trim() ? "Note added" : "Add note"}
        </button>
      )}

      {noteOpen && !isComplete && (
        <div className="athlete-note-backdrop" role="presentation">
          <section
            className="athlete-note-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="athlete-note-title"
          >
            <h2 id="athlete-note-title">Athlete note</h2>
            <p>{teamAthletes.map((item) => item.name).join(" + ")}</p>
            <textarea
              autoFocus
              maxLength={1000}
              value={snapshot.session.athleteNote ?? ""}
              onChange={(event) => updateAthleteNote(event.target.value)}
              placeholder="Add an observation for Race Control…"
            />
            <small>{snapshot.session.athleteNote?.length ?? 0} / 1000</small>
            <button
              className="timing-primary"
              onClick={() => {
                setNoteOpen(false);
                void flushAthleteNote();
              }}
            >
              Done
            </button>
          </section>
        </div>
      )}

      <div className="timing-clock-strip" aria-label="Live timing clocks">
        <div>
          <small>RACE TIME</small>
          <b>{formatRaceTime(totalMs)}</b>
        </div>
        <div>
          <small>STEP TIME</small>
          <b>{formatRaceTime(stageMs)}</b>
        </div>
      </div>
      <div
        className={`timing-queue-state${isComplete && !sent ? " pending" : ""}`}
        role="status"
      >
        {!isComplete
          ? "Timing on this tablet"
          : sent
            ? "Sent to RaceResult"
            : "Not sent to RaceResult yet"}
      </div>

      {snapshot.session.isOoc && (
        <div className="timing-ooc" role="status">
          <b>OOC · Incomplete station</b>
          <span>
            Keep timing every remaining stage through the Finish Line.
          </span>
        </div>
      )}

      <div className="timing-course-strip" aria-label="Race progress">
        {raceStages
          .filter((item) => !["ready", "complete"].includes(item.id))
          .map((item) => {
            const index = raceStages.findIndex(
              (candidate) => candidate.id === item.id,
            );
            return (
              <span
                key={item.id}
                className={
                  index < courseIndex
                    ? "done"
                    : index === courseIndex
                      ? "active"
                      : ""
                }
                title={item.name}
              />
            );
          })}
      </div>

      <div className="timing-layout">
        <article className="timing-stage-card">
          <div className="timing-stage-kicker">
            <span>NOW TIMING</span>
            {startMs && !isComplete && <b>{formatRaceTime(stageMs)}</b>}
          </div>
          <h1>{stage.name}</h1>
          <p>{stage.instruction}</p>

          {error && (
            <div className="timing-action-error" role="alert">
              {error}
            </div>
          )}

          {stage.kind === "ready" && (
            <MobileActionDock>
              {cognitiveSequence.length !== cognitiveSequenceLength && (
                <div className="timing-action-error" role="alert">
                  No valid cognitive pattern is assigned. Keep this athlete at
                  the start and contact Race Control.
                </div>
              )}
              <button
                className="timing-primary timing-show-colours"
                disabled={
                  busy || cognitiveSequence.length !== cognitiveSequenceLength
                }
                onClick={() => void act({ action: "start" })}
              >
                <span>Show Colours</span>
                <small>Starts the race and memorisation time</small>
              </button>
              {undoControl}
            </MobileActionDock>
          )}

          {stage.kind === "memorise" && (
            <>
              <div
                className="timing-sequence"
                aria-label="Colour sequence to memorise"
              >
                {cognitiveSequence.map((color, index) => (
                  <div
                    key={index}
                    style={
                      {
                        "--memory-color": colorChoices[color].color,
                        "--memory-text": colorChoices[color].textColor,
                      } as React.CSSProperties
                    }
                  >
                    <small>{index + 1}</small>
                    <b>{color}</b>
                  </div>
                ))}
              </div>
              <div className="timing-callout">
                Keep these colours visible. Tap only when the athlete says they
                are ready.
              </div>
              <MobileActionDock>
                <button
                  className="timing-primary"
                  disabled={busy}
                  onClick={() => void act({ action: "memorise_complete" })}
                >
                  <span>Cognitive Memorise Complete</span>
                  <small>Hide colours and start 200 m Run 1</small>
                </button>
                {undoControl}
              </MobileActionDock>
            </>
          )}

          {stage.kind === "team_start" && (
            <>
              <div className="timing-callout">
                Both athletes are ready. Start the shared clock when the first
                partner crosses the line.
              </div>
              <MobileActionDock>
                <button
                  className="timing-primary timing-show-colours"
                  disabled={busy}
                  onClick={() => void act({ action: "team_start" })}
                >
                  <span>First partner starts</span>
                  <small>Starts the one team clock</small>
                </button>
                {undoControl}
              </MobileActionDock>
            </>
          )}

          {stage.kind === "station" && (
            <MobileActionDock>
              <div className="timing-dock-stack">
                <div className="timing-outcomes">
                  <label className={outcome === "none" ? "selected" : ""}>
                    <input
                      type="radio"
                      name="outcome"
                      checked={outcome === "none"}
                      onChange={() => setOutcome("none")}
                    />
                    <b>Clear</b>
                    <span>Station completed correctly</span>
                  </label>
                  {stage.stationNumber === 3 &&
                    allowsBearCrawlPenalty(athlete.contestId) && (
                      <label
                        className={
                          outcome === "penalty" ? "selected penalty" : ""
                        }
                      >
                        <input
                          type="radio"
                          name="outcome"
                          checked={outcome === "penalty"}
                          onChange={() => setOutcome("penalty")}
                        />
                        <b>+10 sec penalty</b>
                        <span>Knee touched during Bear Crawl</span>
                      </label>
                    )}
                  <label className={outcome === "ics" ? "selected ics" : ""}>
                    <input
                      type="radio"
                      name="outcome"
                      checked={outcome === "ics"}
                      onChange={() => setOutcome("ics")}
                    />
                    <b>ICS</b>
                    <span>Incomplete station · marks athlete OOC</span>
                  </label>
                </div>
                <button
                  className={`timing-primary${outcome === "ics" ? " danger" : ""}`}
                  disabled={busy}
                  onClick={() => void completeCurrentStage()}
                >
                  <span>Complete {stage.name}</span>
                  <small>
                    {stage.id === "station_6"
                      ? "Start Cognitive Recall"
                      : `Next: ${raceStage(stage.nextId ?? "")?.name ?? "Finish"}`}
                  </small>
                </button>
                {undoControl}
              </div>
            </MobileActionDock>
          )}

          {stage.kind === "run" && (
            <MobileActionDock>
              <button
                className={`timing-primary${outcome === "ics" ? " danger" : ""}`}
                disabled={busy}
                onClick={() => void completeCurrentStage()}
              >
                <span>Complete {stage.name}</span>
                <small>
                  {stage.id === "station_6"
                    ? "Close Tyre Flips and start Cognitive Recall"
                    : `Next: ${raceStage(stage.nextId ?? "")?.name ?? "Finish"}`}
                </small>
              </button>
              {undoControl}
            </MobileActionDock>
          )}

          {stage.kind === "recall" && (
            <>
              <div className="timing-recall-progress">
                {cognitiveSequence.map((_, index) => {
                  const answer = recall[index];
                  const choice = answer ? colorChoices[answer] : null;
                  return (
                    <span
                      key={index}
                      className={answer ? "filled" : ""}
                      style={
                        choice
                          ? ({
                              "--response-color": choice.color,
                              "--response-text": choice.textColor,
                            } as React.CSSProperties)
                          : undefined
                      }
                      aria-label={
                        answer
                          ? `Answer ${index + 1}: ${answer}`
                          : `Answer ${index + 1}: waiting`
                      }
                    >
                      {answer ?? index + 1}
                    </span>
                  );
                })}
              </div>
              <MobileActionDock>
                <div className="timing-dock-stack">
                  <div className="timing-colour-buttons">
                    {(Object.keys(colorChoices) as ColorKey[]).map((color) => (
                      <button
                        key={color}
                        disabled={
                          busy ||
                          recallSubmitting ||
                          recall.length >= cognitiveSequenceLength
                        }
                        onClick={() => void tapColour(color)}
                        style={
                          {
                            "--tap-color": colorChoices[color].color,
                            "--tap-text": colorChoices[color].textColor,
                          } as React.CSSProperties
                        }
                      >
                        <b>{colorChoices[color].label}</b>
                        <span>Tap {color}</span>
                      </button>
                    ))}
                  </div>
                  {recall.length > 0 && !recallSubmitting && (
                    <div className="timing-recall-edits">
                      <button className="timing-reset" onClick={undoColour}>
                        Undo colour
                      </button>
                      <button className="timing-reset" onClick={resetRecall}>
                        Reset recall
                      </button>
                    </div>
                  )}
                  {recall.length === cognitiveSequenceLength && (
                    <button
                      className="timing-primary"
                      disabled={busy || recallSubmitting}
                      onClick={() => void completeRecall()}
                    >
                      <span>
                        {recallSubmitting
                          ? "Saving Cognitive Recall…"
                          : "Complete Cognitive Recall"}
                      </span>
                      <small>
                        Records Tyre Flip + Recall time and starts the finish
                        transition
                      </small>
                    </button>
                  )}
                </div>
              </MobileActionDock>
              <div className="timing-callout">
                {recall.length} of {cognitiveSequenceLength} colours · Review
                the response before completing recall.
              </div>
            </>
          )}

          {stage.kind === "finish" && (
            <>
              {snapshot.cognitive && (
                <>
                  <div className="timing-recall-review">
                    <b>{doubles ? "Team response" : "Athlete response"}</b>
                    <div className="timing-review-row">
                      {snapshot.cognitive.response.map((answer, index) => {
                        const choice = colorChoices[answer];
                        const correct = answer === cognitiveSequence[index];
                        return (
                          <span
                            key={index}
                            className={correct ? "correct" : "incorrect"}
                            style={
                              {
                                "--response-color": choice.color,
                                "--response-text": choice.textColor,
                              } as React.CSSProperties
                            }
                            aria-label={`Answer ${index + 1}: ${answer}, ${correct ? "correct" : "incorrect"}`}
                          >
                            <b>{answer}</b>
                            <small>{correct ? "✓" : "×"}</small>
                          </span>
                        );
                      })}
                    </div>
                    <b>Actual sequence</b>
                    <div className="timing-review-row actual">
                      {cognitiveSequence.map((answer, index) => {
                        const choice = colorChoices[answer];
                        return (
                          <span
                            key={index}
                            style={
                              {
                                "--response-color": choice.color,
                                "--response-text": choice.textColor,
                              } as React.CSSProperties
                            }
                            aria-label={`Actual colour ${index + 1}: ${answer}`}
                          >
                            <b>{answer}</b>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className="timing-cognitive-result">
                    <div>
                      <small>CORRECT</small>
                      <b>{snapshot.cognitive.correctCount}/10</b>
                    </div>
                    <div>
                      <small>SCORE</small>
                      <b>{snapshot.cognitive.percentage}%</b>
                    </div>
                    <div>
                      <small>ADJUSTMENT</small>
                      <b>
                        {snapshot.cognitive.bonusSeconds
                          ? `30 s bonus`
                          : snapshot.cognitive.penaltySeconds
                            ? `+30 s`
                            : "No change"}
                      </b>
                    </div>
                  </div>
                </>
              )}
              <div className="timing-cognitive-result">
                <div>
                  <small>TYRE FLIP + RECALL</small>
                  <b>
                    {snapshot.finalSegments.tyreFlipRecallMs == null
                      ? "—"
                      : formatRaceTime(snapshot.finalSegments.tyreFlipRecallMs)}
                  </b>
                </div>
                <div>
                  <small>RECALL-TO-FINISH</small>
                  <b>
                    {snapshot.finalSegments.recallCompletedAt
                      ? formatRaceTime(
                          now -
                            new Date(
                              snapshot.finalSegments.recallCompletedAt,
                            ).getTime(),
                        )
                      : "—"}
                  </b>
                </div>
              </div>
              <MobileActionDock>
                <button
                  className="timing-primary timing-finish"
                  disabled={busy}
                  onClick={() => void finishRace()}
                >
                  <span>
                    {doubles ? "Last partner finishes" : "Finish Race"}
                  </span>
                  <small>
                    {doubles
                      ? "Tap when the second athlete crosses the Finish Line"
                      : "Tap when the athlete crosses the Finish Line"}
                  </small>
                </button>
                {undoControl}
              </MobileActionDock>
            </>
          )}

          {isComplete && (
            <div className="timing-complete">
              <div className="timing-complete-mark">✓</div>
              <h2>
                {doubles ? "Team timing complete" : "Race timing complete"}
              </h2>
              <p>
                All manual splits are saved. RaceResult updates continue
                automatically if any are pending.
              </p>
              <div className="timing-final-time">
                <small>MANUAL TOTAL</small>
                <b>{formatRaceTime(totalMs)}</b>
              </div>
              <div className="timing-cognitive-result">
                <div>
                  <small>TYRE FLIP + RECALL</small>
                  <b>
                    {snapshot.finalSegments.tyreFlipRecallMs == null
                      ? "—"
                      : formatRaceTime(snapshot.finalSegments.tyreFlipRecallMs)}
                  </b>
                </div>
                <div>
                  <small>RECALL-TO-FINISH</small>
                  <b>
                    {snapshot.finalSegments.recallToFinishMs == null
                      ? "—"
                      : formatRaceTime(snapshot.finalSegments.recallToFinishMs)}
                  </b>
                </div>
              </div>
              {/* The race lives on this tablet until RaceResult accepts it, so
                  an undelivered one has to be impossible to walk away from. */}
              <div
                className={`timing-delivery-state ${sent ? "confirmed" : "attention"}`}
              >
                <b>
                  {sent
                    ? doubles
                      ? "Sent to RaceResult for both BIBs"
                      : "Sent to RaceResult"
                    : "This race is not in RaceResult yet"}
                </b>
                <span>
                  {sent
                    ? "Nothing is kept on this tablet once you move on."
                    : "It is held on this tablet only. Sending again is safe — it overwrites the same fields rather than adding to them."}
                </span>
                {!sent && (
                  <button
                    className="timing-secondary"
                    disabled={busy}
                    onClick={() => void deliver(snapshotRef.current)}
                  >
                    {busy ? "Sending…" : "Send to RaceResult"}
                  </button>
                )}
              </div>
              <MobileActionDock>
                <button
                  className="timing-primary"
                  disabled={!sent || busy}
                  onClick={judgeNext}
                >
                  {!sent
                    ? "Send the race first"
                    : doubles
                      ? "Time next team"
                      : "Time next athlete"}
                </button>
                {undoControl}
              </MobileActionDock>
            </div>
          )}
        </article>

        <aside className="timing-splits-panel">
          <div className="timing-panel-heading">
            <div>
              <small>BACKUP TIMING</small>
              <b>Recorded splits</b>
            </div>
            <span>{snapshot.splits.length}</span>
          </div>
          <div className="timing-split-list">
            {[...snapshot.splits].reverse().map((split) => (
              <div key={split.id}>
                <span>
                  <b>{split.stageName}</b>
                  <small>
                    Segment {formatRaceTime(numeric(split.segmentMs))}
                  </small>
                </span>
                <strong>{formatRaceTime(numeric(split.cumulativeMs))}</strong>
              </div>
            ))}
            {!snapshot.splits.length && (
              <p>Your first split appears after Show Colours.</p>
            )}
          </div>
          <div className="timing-sync-note">
            <span>↻</span>
            <div>
              <b>RR14 sync is automatic</b>
              <small>Manual timing stays in this backup app.</small>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
