"use client";

/* The Results screen: RaceResult's standings, and what becomes of them.
 *
 * Two destinations, one feed. Pulling LIVE writes a single Valkey key and
 * touches no table, so an operator can pull a half-finished race twenty times
 * without the database's answer to "what happened" changing under anybody.
 * STORING replaces this event's rows in `athletes` and `results` — the act of
 * saying these are the numbers.
 *
 * The mode below is what a reader is served, and it is deliberately separate
 * from both buttons: pulling a feed does not publish it, and publishing does
 * not re-pull. An operator who wanted one and silently got the other is how a
 * mid-race snapshot ends up on a finished event's results page.
 *
 * Each of the three acts also takes a FILE, for the event whose feed cannot be
 * reached — an offline venue, a RaceResult server that is down, an export that
 * arrived by email. An upload is the same act as the pull beside it and lands
 * in the same place; only where the JSON came from differs. It is offered next
 * to each button rather than on a screen of its own so that "import the
 * standings" stays one idea with two doors, and so an operator who has already
 * learned what Live and Stored mean does not have to learn it twice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { judgeApi, judgeUpload, fmtMs } from "../../../../../lib/api";
import { Spinner, ErrorNote, Empty, statusChip } from "../../../../../lib/ui";
import SplitTimeline from "../../../../../lib/split-timeline";
import { FieldSignIn, useFieldSession } from "../../../../../lib/field-session";
import EventPicker from "../event-picker";

type Mode = "off" | "live" | "stored";

type State = {
    eventId: string;
    eventName: string;
    mode: Mode;
    resultsConfigured: boolean;
    participantConfigured: boolean;
    cacheKey: string;
    live: {
        fetched_at: string;
        rows: number;
        rejected: number;
        rejections: Rejection[];
    } | null;
    stored: { results: number; athletes: number; at: string | null };
};

type Row = {
    bib: string;
    name: string;
    category: string | null;
    club: string | null;
    status: string;
    rank: number | null;
    age_group: string | null;
    age_group_rank: number | null;
    /** The athlete's age on race day, as the export gave it. */
    age: number | null;
    total_ms: number | null;
    team_time_ms: number | null;
    team_rank: number | null;
    cog_ms: number | null;
    run_ms: (number | null)[];
    station_ms: (number | null)[];
    penalties: Record<string, string>;
    extra_times: Record<string, string>;
};

type Payload = {
    event_name: string;
    source: "live" | "stored";
    fetched_at: string;
    source_count: number;
    rejected: number;
    /** Absent on a payload cached by a build from before this shipped. */
    rejections?: Rejection[];
    rows: Row[];
};

/* One row of the file that did not become a result.
 *
 * `row` is its 1-based position in the file, or 0 when the drop happened after
 * parsing — the athlete-key collision below, which is found a pass later and
 * has no line to point at. */
type Rejection = {
    row: number;
    bib: string;
    name: string;
    category: string;
    reason: "no-bib" | "duplicate-entry" | "same-athlete-twice";
};

/* Said as a sentence an organiser can act on. The three cases need three
 * different fixes, which is the whole reason for showing them apart: a missing
 * bib is a hole in the export, a repeated entry is the export contradicting
 * itself, and one athlete twice in a contest is usually a bib reassigned
 * mid-day and left in the file under both numbers. */
const REJECTION_REASON: Record<Rejection["reason"], string> = {
    "no-bib": "no usable bib number",
    "duplicate-entry": "this bib already appeared in this contest",
    "same-athlete-twice": "this athlete already has a result in this contest, under another bib",
};

const MODES: { value: Mode; label: string; hint: string }[] = [
    { value: "off", label: "Not published", hint: "The public results page answers 404" },
    { value: "live", label: "Live from cache", hint: "Serve the last pull — provisional, and it expires" },
    { value: "stored", label: "Stored in database", hint: "Serve the imported results — the ones that will still be here tomorrow" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

/* A row is a bib IN A CONTEST, not a bib: one athlete racing solo and doubles
   at the same event under one number is two rows here, and keying on the bib
   alone collapsed them into one line that opened twice. */
const rowKey = (row: { bib: string; category: string | null }) =>
    `${row.bib}|${(row.category ?? "").toLowerCase()}`;

export default function ResultsPage() {
    const { id: eventId } = useParams<{ id: string }>();
    const { user, ready } = useFieldSession();
    const scoped = (path: string) => `${path}${path.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(eventId)}`;

    const [state, setState] = useState<State | null>(null);
    const [payload, setPayload] = useState<Payload | null>(null);
    const [source, setSource] = useState<"live" | "stored">("live");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");
    /* The rows the last import dropped, from the import that dropped them.
     *
     * `null` means no import has run on this screen yet — which is not the same
     * as an import that rejected nothing, and the panel below says so
     * differently. */
    const [rejections, setRejections] = useState<Rejection[] | null>(null);
    // Expanded splits, by bib. A HYFIT row is fifteen times — showing them all
    // at once makes the standings unreadable, and hiding them entirely means
    // the import cannot be checked against the tablet that produced it.
    const [open, setOpen] = useState<string | null>(null);
    /* Every leg as its own column, off by default.
     *
     * The eight-column table is for reading standings; this is for CHECKING AN
     * IMPORT, which is a different job — after uploading a file the question is
     * not "who won" but "did all thirteen legs land, and in the right order".
     * Expanding one row answers it one athlete at a time; a thousand-row import
     * needs it at a glance, so the whole grid goes wide and scrolls sideways. */
    const [allSplits, setAllSplits] = useState(false);

    const loadPreview = useCallback(
        async (which: "live" | "stored") => {
            const data = await judgeApi<{ payload: Payload | null }>(scoped(`/admin/results/preview?source=${which}`));
            setPayload(data.payload);
        },
        [eventId],
    );

    const load = useCallback(async () => {
        setErr("");
        try {
            const data = await judgeApi<State>(scoped("/admin/results"));
            setState(data);
            // Open on whichever half has something in it, preferring what the
            // event is actually publishing — a screen that opens on an empty
            // tab when there are standings one click away reads as broken.
            const which: "live" | "stored" =
                data.mode === "stored" ? "stored" : data.live ? "live" : data.stored.results ? "stored" : "live";
            setSource(which);
            await loadPreview(which);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setLoading(false);
        }
    }, [eventId, loadPreview]);

    useEffect(() => {
        setMsg("");
        setPayload(null);
        setLoading(true);
    }, [eventId]);

    useEffect(() => {
        if (user) void load();
        else if (ready) setLoading(false);
    }, [user, ready, load]);

    /* Every import says whether anybody can see the result of it. The count
       alone reads as "done", and for an event still set to "Not published" that
       is exactly the wrong impression — the rows landed and the public page is
       still answering 404. */
    const unpublished = () => (state?.mode === "off" ? " · not published yet" : "");

    const run = async (label: string, fn: () => Promise<string>, publishes = false) => {
        setBusy(label);
        setErr("");
        setMsg("");
        // The previous import's rejections belong to the previous import. Left
        // on screen they would read as this one's, which is the one thing this
        // panel exists to answer.
        setRejections(null);
        try {
            const done = await fn();
            setMsg(publishes ? done : done + unpublished());
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
        }
    };

    const pullLive = () =>
        run("live", async () => {
            const out = await judgeApi<Payload>(scoped("/admin/results/pull"), {
                method: "POST",
                body: JSON.stringify({ store: false }),
            });
            setRejections(out.rejections ?? []);
            return `${out.rows.length} rows cached${out.rejected ? ` · ${out.rejected} rejected` : ""}`;
        });

    const storeResults = () =>
        run("store", async () => {
            const out = await judgeApi<{
                imported: number;
                athletesCreated: number;
                rejected: number;
                rejections?: Rejection[];
            }>(scoped("/admin/results/pull"), { method: "POST", body: JSON.stringify({ store: true }) });
            setRejections(out.rejections ?? []);
            return `${out.imported} results stored${
                out.athletesCreated ? ` · ${out.athletesCreated} athletes created from the feed` : ""
            }${out.rejected ? ` · ${out.rejected} rejected` : ""}`;
        });

    const importAthletes = () =>
        run("athletes", async () => {
            const out = await judgeApi<{
                imported: number;
                created: number;
                updated: number;
                removed: number;
            }>(scoped("/admin/athletes/import"), { method: "POST", body: JSON.stringify({}) });
            return `${out.imported} athletes imported · ${out.created} new, ${out.updated} updated${
                out.removed ? `, ${out.removed} removed` : ""
            }`;
        }, true);

    /* The same three imports, from a picked file.
     *
     * They report the file's name back, because the one mistake this door adds
     * that the endpoint does not is picking the wrong file — last year's export,
     * the participant list where the standings were meant. A count alone reads
     * as success in that case; a count next to the name is checkable. */
    const uploadResults = (store: boolean) => (file: File) =>
        run(store ? "upload-store" : "upload-live", async () => {
            const out = await judgeUpload<Payload & { imported?: number; athletesCreated?: number }>(
                scoped(`/admin/results/upload`),
                file,
                { store: String(store) },
            );
            setRejections(out.rejections ?? []);
            return store
                ? `${out.imported} results stored from ${file.name}${
                      out.athletesCreated ? ` · ${out.athletesCreated} athletes created from the file` : ""
                  }${out.rejected ? ` · ${out.rejected} rejected` : ""}`
                : `${out.rows.length} rows cached from ${file.name}${
                      out.rejected ? ` · ${out.rejected} rejected` : ""
                  }`;
        });

    const uploadAthletes = (file: File) =>
        run("upload-athletes", async () => {
            const out = await judgeUpload<{
                imported: number;
                created: number;
                updated: number;
                removed: number;
            }>(scoped("/admin/athletes/upload"), file);
            return `${out.imported} athletes imported from ${file.name} · ${out.created} new, ${out.updated} updated${
                out.removed ? `, ${out.removed} removed` : ""
            }`;
        }, true);

    /* Empty the Valkey key for this event.
     *
     * Deliberately does NOT touch the mode: "that pull was wrong, throw it
     * away" and "stop publishing results" are different intentions, and an
     * operator who meant the first should not silently get the second. The
     * message says what the consequence is when the event is still live —
     * athletes fall back to "no results published" until the next pull. */
    const discard = () =>
        run("discard", async () => {
            await judgeApi(scoped("/admin/results/discard"), { method: "POST", body: JSON.stringify({}) });
            setPayload(null);
            return state?.mode === "live"
                ? "Cache cleared — athletes see no results until the next pull"
                : "Cache cleared";
        }, true);

    const setMode = (mode: Mode) =>
        run("mode", async () => {
            await judgeApi(scoped("/admin/results/mode"), { method: "PUT", body: JSON.stringify({ mode }) });
            return `Results ${mode === "off" ? "unpublished" : `published — ${mode}`}`;
        }, true);

    const showSource = async (which: "live" | "stored") => {
        setSource(which);
        setErr("");
        try {
            await loadPreview(which);
        } catch (e: any) {
            setErr(e.message);
        }
    };

    /* The extra-time columns THIS feed published — the union across the rows,
       in the order they first appear, because a row that was still on course
       when the file was exported carries fewer of them than a finisher. */
    const extraCols = Array.from(
        new Set((payload?.rows ?? []).flatMap((r) => Object.keys(r.extra_times ?? {}))),
    );

    /* The penalty and bonus columns THIS feed published, the same way — and as
       COLUMNS rather than as the chips the athlete sees.
       
       The chips are filtered to the ones that scored (see split-timeline), which
       is right for a scorecard and useless for checking an import: a station
       judged clean and a station never judged both vanish. Here every column the
       export carried gets a heading, so a blank cell means "this row said
       nothing" and a "0" means "this row said clean" — which is the difference
       an operator is looking at this table to find. */
    const penaltyCols = Array.from(
        new Set((payload?.rows ?? []).flatMap((r) => Object.keys(r.penalties ?? {}))),
    );

    if (!ready || (loading && user)) return <Spinner />;

    if (!user) {
        return (
            <div>
                <h1 className="text-2xl font-black uppercase tracking-wide">Results</h1>
                <p className="mt-1 text-sm text-fog">RaceResult standings for this event</p>
                <FieldSignIn what="results" />
            </div>
        );
    }

    return (
        <div>
            <Link
                href={`/hyfitgames/admin/events`}
                className="text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk"
            >
                ← All events
            </Link>
            <h1 className="mt-2 text-2xl font-black uppercase tracking-wide">Results</h1>
            <p className="mt-1 text-sm text-fog">
                Pull the standings from RaceResult — or upload them as a JSON file — then choose what a reader
                is served
            </p>
            <EventPicker eventId={eventId} segment="results" />

            {msg && <div className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">{msg}</div>}
            <ErrorNote msg={err} />
            {/* Which rows the count in that message is about. Closed by
                default — a clean import should not make anybody read a list —
                and it stays on screen after the message so the rows can be
                copied into whatever fixes the export. */}
            <RejectionPanel rejections={rejections} source="the last import" />
            {/* The same question, asked later: the cached pull keeps its own
                rejections, so an operator who walks away and comes back can
                still find out which rows were dropped. Only when this screen
                has not just run an import itself, or the two lists would sit
                one above the other saying the same thing. */}
            {rejections === null && state?.live?.rejections?.length ? (
                <RejectionPanel
                    rejections={state.live!.rejections}
                    source={`the cached pull of ${when(state.live!.fetched_at)}`}
                />
            ) : null}

            {state && !state.resultsConfigured && (
                <div className="mt-4 rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm text-fog">
                    This event has no results endpoint yet. Set one on{" "}
                    <Link href={`/hyfitgames/admin/events/${eventId}/operations`} className="font-bold text-chalk underline">
                        Operations
                    </Link>{" "}
                    — it is its own RaceResult Custom API key, separate from the participant one. An event
                    scored offline needs none: upload the standings as a JSON file instead.
                </div>
            )}

            {/* ------------------------------------------------------- actions */}
            <div className="mt-6 grid gap-4 lg:grid-cols-3">
                <Card
                    title="Live"
                    body={
                        state?.live
                            ? `${state.live.rows} rows · pulled ${when(state.live.fetched_at)}`
                            : "Nothing cached"
                    }
                    hint={state ? `Key: ${state.cacheKey}` : ""}
                    action="Pull into cache"
                    busy={busy === "live"}
                    disabled={!state?.resultsConfigured || !!busy}
                    onClick={pullLive}
                    extra={
                        <>
                            <UploadButton
                                label="Upload JSON → cache"
                                busy={busy === "upload-live"}
                                disabled={!!busy}
                                onPick={uploadResults(false)}
                            />
                            {/* Always rendered, disabled when there is nothing to
                                clear. A control that appears only once it has
                                something to do is a control an operator cannot
                                find when they go looking for it. */}
                            <button
                                onClick={discard}
                                disabled={!state?.live || !!busy}
                                className="mt-2 w-full rounded-lg border border-smoke px-3 py-2 text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk disabled:opacity-40"
                            >
                                {busy === "discard"
                                    ? "Clearing…"
                                    : state?.live
                                      ? `Clear cache · ${state.live.rows} rows`
                                      : "Cache empty"}
                            </button>
                        </>
                    }
                />
                <Card
                    title="Stored"
                    body={
                        state?.stored.results
                            ? `${state.stored.results} results · imported ${when(state.stored.at)}`
                            : "Nothing stored"
                    }
                    hint="Replaces this event's stored results"
                    action="Import into database"
                    busy={busy === "store"}
                    disabled={!state?.resultsConfigured || !!busy}
                    onClick={storeResults}
                    extra={
                        <UploadButton
                            label="Upload JSON → database"
                            busy={busy === "upload-store"}
                            disabled={!!busy}
                            onPick={uploadResults(true)}
                        />
                    }
                />
                <Card
                    title="Athletes"
                    body={state?.stored.athletes ? `${state.stored.athletes} on the start list` : "No start list imported"}
                    hint="From the participant endpoint"
                    action="Import athletes"
                    busy={busy === "athletes"}
                    disabled={!state?.participantConfigured || !!busy}
                    onClick={importAthletes}
                    extra={
                        <UploadButton
                            label="Upload JSON start list"
                            busy={busy === "upload-athletes"}
                            disabled={!!busy}
                            onPick={uploadAthletes}
                        />
                    }
                />
            </div>

            {/* ---------------------------------------------------------- mode */}
            <h2 className="mt-8 text-sm font-bold uppercase tracking-wide">What the public sees</h2>

            {/* IMPORTING IS NOT PUBLISHING, and this is where an operator finds
                that out. Pulling or uploading writes the cache or the tables and
                deliberately leaves the mode alone — so an event whose standings
                have just landed still serves 404 to every athlete, and the only
                sign of it was a radio button sitting on "Not published".
                Rendered only when there is something to publish, so it is a
                prompt at exactly the moment it is actionable, never a nag. */}
            {state?.mode === "off" && (state.live || state.stored.results > 0) && (
                <div className="mt-3 rounded-lg border border-hyred bg-coal px-3 py-2.5 text-sm">
                    <p className="font-medium">
                        {[
                            state.live ? `${state.live.rows} rows cached` : "",
                            state.stored.results ? `${state.stored.results} results stored` : "",
                        ]
                            .filter(Boolean)
                            .join(" · ")}{" "}
                        — and nobody can see them yet.
                    </p>
                    <p className="mt-1 text-xs text-fog">
                        The public results page answers 404 until this event publishes one of them.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {state.live && (
                            <button
                                onClick={() => setMode("live")}
                                disabled={!!busy}
                                className="rounded-lg bg-hyred px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-onfill disabled:opacity-40"
                            >
                                Publish live
                            </button>
                        )}
                        {state.stored.results > 0 && (
                            <button
                                onClick={() => setMode("stored")}
                                disabled={!!busy}
                                className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk disabled:opacity-40"
                            >
                                Publish stored
                            </button>
                        )}
                    </div>
                </div>
            )}
            <div className="mt-3 space-y-2">
                {MODES.map((m) => (
                    <label
                        key={m.value}
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 ${
                            state?.mode === m.value ? "border-hyred bg-coal" : "border-smoke bg-coal"
                        }`}
                    >
                        <input
                            type="radio"
                            name="results-mode"
                            className="h-4 w-4"
                            checked={state?.mode === m.value}
                            disabled={!!busy}
                            onChange={() => setMode(m.value)}
                        />
                        <div>
                            <p className="text-sm font-medium">{m.label}</p>
                            <p className="text-xs text-fog">{m.hint}</p>
                        </div>
                    </label>
                ))}
            </div>
            {state && state.mode !== "off" && (
                <p className="mt-2 text-xs text-fog">
                    Public page:{" "}
                    <Link href={`/hyfitgames/live-results/${state.eventId}`} className="font-mono underline hover:text-chalk">
                        /hyfitgames/live-results/{state.eventId}
                    </Link>
                </p>
            )}

            {/* ------------------------------------------------------- preview */}
            <div className="mt-8 flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wide">Standings</h2>
                <div className="flex gap-2">
                    <button
                        onClick={() => setAllSplits(!allSplits)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-widest ${
                            allSplits ? "bg-hyred text-onfill" : "border border-smoke text-fog hover:text-chalk"
                        }`}
                    >
                        All splits
                    </button>
                    {(["live", "stored"] as const).map((which) => (
                        <button
                            key={which}
                            onClick={() => showSource(which)}
                            className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-widest ${
                                source === which ? "bg-hyred text-onfill" : "border border-smoke text-fog hover:text-chalk"
                            }`}
                        >
                            {which}
                        </button>
                    ))}
                </div>
            </div>

            {!payload ? (
                <Empty
                    title={source === "live" ? "Nothing cached" : "Nothing stored"}
                    hint={
                        source === "live"
                            ? "Pull the feed into the cache to see the standings here."
                            : "Import the feed into the database to see the standings here."
                    }
                />
            ) : (
                <>
                    <p className="mt-2 text-xs text-fog">
                        {payload.source === "live" ? "Cached" : "Stored"} · {payload.rows.length} rows ·{" "}
                        {when(payload.fetched_at)}
                        {payload.rejected ? ` · ${payload.rejected} rejected` : ""}
                    </p>
                    <div className="mt-3 overflow-x-auto rounded-lg border border-smoke">
                        <table className={`w-full text-sm ${allSplits ? "min-w-[1500px]" : "min-w-[720px]"}`}>
                            <thead className="bg-coal text-xs uppercase tracking-wider text-fog">
                                <tr>
                                    <th className="px-3 py-2 text-left">#</th>
                                    <th className="px-3 py-2 text-left">Bib</th>
                                    <th className="px-3 py-2 text-left">Name</th>
                                    <th className="px-3 py-2 text-left">Category</th>
                                    {/* Beside the band, not inside it: the band is
                                        the claim and the age is what makes it
                                        checkable. */}
                                    <th className="px-3 py-2 text-right">Age</th>
                                    <th className="px-3 py-2 text-left">Club</th>
                                    {allSplits &&
                                        LEG_HEADS.map((h) => (
                                            <th key={h} className="px-2 py-2 text-right">
                                                {h}
                                            </th>
                                        ))}
                                    <th className="px-3 py-2 text-right">Total</th>
                                    <th className="px-3 py-2 text-right">Team</th>
                                    {allSplits &&
                                        extraCols.map((h) => (
                                            <th key={h} className="px-2 py-2 text-right">
                                                {h}
                                            </th>
                                        ))}
                                    {allSplits &&
                                        penaltyCols.map((h) => (
                                            <th key={h} className="px-2 py-2 text-right">
                                                {h}
                                            </th>
                                        ))}
                                    <th className="px-3 py-2 text-left">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {payload.rows.map((r) => (
                                    <RowLines
                                        key={rowKey(r)}
                                        row={r}
                                        allSplits={allSplits}
                                        extraCols={extraCols}
                                        penaltyCols={penaltyCols}
                                        open={open === rowKey(r)}
                                        onToggle={() => setOpen(open === rowKey(r) ? null : rowKey(r))}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}

function Card({
    title,
    body,
    hint,
    action,
    busy,
    disabled,
    onClick,
    extra,
}: {
    title: string;
    body: string;
    hint: string;
    action: string;
    busy: boolean;
    disabled: boolean;
    onClick: () => void;
    extra?: React.ReactNode;
}) {
    return (
        <div className="rounded-lg border border-smoke bg-coal p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-fog">{title}</p>
            <p className="mt-1 text-sm">{body}</p>
            {hint && <p className="mt-1 break-all text-xs text-fog">{hint}</p>}
            <button
                onClick={onClick}
                disabled={disabled}
                className="mt-3 w-full rounded-lg bg-hyred px-3 py-2 text-xs font-bold uppercase tracking-widest text-onfill disabled:opacity-40"
            >
                {busy ? "Working…" : action}
            </button>
            {extra}
        </div>
    );
}

/* Pick a file and hand it straight to the import.
 *
 * No preview step and no second confirmation: the imports these sit beside have
 * none either, and the file is checked where the feed is — by the parser, which
 * refuses a payload with no bib column and says which columns it did find.
 *
 * The input is cleared on every pick (`value = ""`). Without that, choosing the
 * same file twice fires no change event, so an operator who fixed the export and
 * re-picked it would get silence and assume the button was broken.
 */
function UploadButton({
    label,
    busy,
    disabled,
    onPick,
}: {
    label: string;
    busy: boolean;
    disabled: boolean;
    onPick: (file: File) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={input}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) onPick(file);
                }}
            />
            <button
                onClick={() => input.current?.click()}
                disabled={disabled}
                className="mt-2 w-full rounded-lg border border-smoke px-3 py-2 text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk disabled:opacity-40"
            >
                {busy ? "Uploading…" : label}
            </button>
        </>
    );
}

/* The circuit as column headings, in the order it is run. Short because there
   are thirteen of them and the table already scrolls. */
const LEG_HEADS = [
    "COG",
    "R1", "S1",
    "R2", "S2",
    "R3", "S3",
    "R4", "S4",
    "R5", "S5",
    "R6", "S6",
];

/** The same thirteen, as this row's times. Built from the arrays rather than
 *  from named fields so the order here cannot drift from the headings above. */
const legTimes = (row: Row): (number | null)[] => [
    row.cog_ms,
    ...[0, 1, 2, 3, 4, 5].flatMap((i) => [row.run_ms?.[i] ?? null, row.station_ms?.[i] ?? null]),
];

/* One athlete: the standings line, and their circuit underneath it when opened.
 * The splits are a second <tr> rather than a nested table so the columns stay
 * aligned with the row they belong to. */
function RowLines({
    row,
    allSplits,
    extraCols,
    penaltyCols,
    open,
    onToggle,
}: {
    row: Row;
    allSplits: boolean;
    extraCols: string[];
    penaltyCols: string[];
    open: boolean;
    onToggle: () => void;
}) {
    return (
        <>
            <tr onClick={onToggle} className="cursor-pointer border-t border-smoke hover:bg-coal">
                <td className="px-3 py-2 text-fog">{row.rank ?? "—"}</td>
                <td className="px-3 py-2 font-mono">{row.bib}</td>
                <td className="px-3 py-2 font-medium">{row.name || "—"}</td>
                <td className="px-3 py-2 text-fog">
                    {row.category ?? "—"}
                    {/* The band under the contest, when the feed carries both.
                        It is what age_group_rank counts within, and checking an
                        import means seeing that the two columns did not collapse
                        into one. */}
                    {row.age_group && (
                        <span className="block text-xs">
                            {row.age_group}
                            {row.age_group_rank != null ? ` · #${row.age_group_rank}` : ""}
                        </span>
                    )}
                </td>
                {/* An em dash, not a blank: an export with no Age column and one
                    that left this athlete's blank are the same fact here, and
                    both are "not published" rather than an age of nothing. */}
                <td className="px-3 py-2 text-right font-mono text-fog">{row.age ?? "—"}</td>
                <td className="px-3 py-2 text-fog">{row.club ?? "—"}</td>
                {/* A leg the feed left blank is an em dash, not a zero: "not
                    recorded" and "instant" are different facts, and on a
                    mid-race export most of the row is the former. */}
                {allSplits &&
                    legTimes(row).map((ms, i) => (
                        <td
                            key={LEG_HEADS[i]}
                            className={`px-2 py-2 text-right font-mono text-xs ${
                                ms == null ? "text-fog" : ""
                            }`}
                        >
                            {ms == null ? "—" : fmtMs(ms)}
                        </td>
                    ))}
                <td className="px-3 py-2 text-right font-mono">{fmtMs(row.total_ms)}</td>
                {/* A team time is the pair's, and only a pair has one — which
                    makes it the "raced as a team" flag as well as a number. The
                    placing beside it is the TEAM's, not the athlete's #rank in
                    the first column. */}
                <td className="px-3 py-2 text-right font-mono text-fog">
                    {fmtMs(row.team_time_ms)}
                    {row.team_rank != null ? ` · #${row.team_rank}` : ""}
                </td>
                {/* statusChip, not a chip of our own: REG/FIN/DNF/DNS/DQ is the
                    same vocabulary the rest of the console renders, and a
                    second mapping of it would drift. */}
                {/* Published as the organiser wrote them — these are strings
                    from the feed, not milliseconds this code has interpreted. */}
                {allSplits &&
                    extraCols.map((name) => (
                        <td key={name} className="px-2 py-2 text-right font-mono text-xs text-fog">
                            {row.extra_times?.[name] ?? "—"}
                        </td>
                    ))}
                {/* Every penalty and bonus the feed carried, zeroes included —
                    see penaltyCols. A scored one is picked out so the eye finds
                    it in a column of noughts. */}
                {allSplits &&
                    penaltyCols.map((name) => {
                        const value = row.penalties?.[name];
                        const scored = /[1-9]/.test(String(value ?? ""));
                        return (
                            <td
                                key={name}
                                className={`px-2 py-2 text-right font-mono text-xs ${
                                    scored ? "font-bold text-warn" : "text-fog"
                                }`}
                            >
                                {value ?? "—"}
                            </td>
                        );
                    })}
                <td className="px-3 py-2">{statusChip(row.status)}</td>
            </tr>
            {open && (
                <tr className="border-t border-smoke bg-coal/50">
                    {/* The same timeline the athlete is looking at, from the
                        same component: an operator checking a suspect split
                        should be reading exactly what the athlete reads. */}
                    {/* Nine fixed columns now that Age is one of them, plus
                        everything the splits view adds. */}
                    <td
                        colSpan={
                            9 +
                            (allSplits
                                ? LEG_HEADS.length + extraCols.length + penaltyCols.length
                                : 0)
                        }
                        className="px-3 py-4"
                    >
                        <div className="max-w-2xl">
                            <SplitTimeline source={row} />
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
}

/* The rows an import did not keep.
 *
 * A count is not an answer: "7 rejected" tells an organiser that seven athletes
 * are missing from the board and nothing about which seven, and the three
 * reasons need three different fixes. Each row is named by its position in the
 * file, its bib exactly as the column held it — "DNS" in a bib column is the
 * whole diagnosis — and the athlete and contest it claimed to be.
 *
 * Nothing is rendered when an import rejected nothing, which is the normal
 * case and deserves no furniture.
 */
function RejectionPanel({
    rejections,
    source,
}: {
    rejections: Rejection[] | null;
    source: string;
}) {
    if (!rejections?.length) return null;

    return (
        <details className="mt-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-warn">
            <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide">
                {rejections.length} row{rejections.length === 1 ? "" : "s"} rejected by {source} — show them
            </summary>
            <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                    <thead className="uppercase tracking-wider opacity-80">
                        <tr>
                            <th className="py-1 pr-3">Row</th>
                            <th className="py-1 pr-3">Bib</th>
                            <th className="py-1 pr-3">Name</th>
                            <th className="py-1 pr-3">Contest</th>
                            <th className="py-1">Why</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rejections.map((r, i) => (
                            <tr key={`${r.row}-${r.bib}-${i}`} className="border-t border-warn/20">
                                {/* Row 0 means the drop happened after parsing —
                                    the athlete-key collision — where there is no
                                    line in the file to point at. Saying "—" is
                                    honest; saying "row 0" is not. */}
                                <td className="py-1 pr-3 font-mono">{r.row || "—"}</td>
                                <td className="py-1 pr-3 font-mono">{r.bib || "(blank)"}</td>
                                <td className="py-1 pr-3">{r.name || "—"}</td>
                                <td className="py-1 pr-3">{r.category || "—"}</td>
                                <td className="py-1">{REJECTION_REASON[r.reason]}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="mt-2 text-[11px] opacity-80">
                Rejected rows are not on the leaderboard and not in the database. Fix the export and import again —
                importing replaces this event's results, so nothing is duplicated by re-running it.
            </p>
        </details>
    );
}

