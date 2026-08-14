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
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { judgeApi, fmtMs } from "../../../../../lib/api";
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
    live: { fetched_at: string; rows: number; rejected: number } | null;
    stored: { results: number; athletes: number; at: string | null };
};

type Row = {
    bib: string;
    name: string;
    category: string | null;
    club: string | null;
    status: string;
    rank: number | null;
    age_group_rank: number | null;
    total_ms: number | null;
    team_time_ms: number | null;
    cog_ms: number | null;
    run_ms: (number | null)[];
    station_ms: (number | null)[];
    penalties: Record<string, string>;
};

type Payload = {
    event_name: string;
    source: "live" | "stored";
    fetched_at: string;
    source_count: number;
    rejected: number;
    rows: Row[];
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
    // Expanded splits, by bib. A HYFIT row is fifteen times — showing them all
    // at once makes the standings unreadable, and hiding them entirely means
    // the import cannot be checked against the tablet that produced it.
    const [open, setOpen] = useState<string | null>(null);

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

    const run = async (label: string, fn: () => Promise<string>) => {
        setBusy(label);
        setErr("");
        setMsg("");
        try {
            setMsg(await fn());
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
            return `${out.rows.length} rows cached${out.rejected ? ` · ${out.rejected} rejected` : ""}`;
        });

    const storeResults = () =>
        run("store", async () => {
            const out = await judgeApi<{ imported: number; athletesCreated: number; rejected: number }>(
                scoped("/admin/results/pull"),
                { method: "POST", body: JSON.stringify({ store: true }) },
            );
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
        });

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
        });

    const setMode = (mode: Mode) =>
        run("mode", async () => {
            await judgeApi(scoped("/admin/results/mode"), { method: "PUT", body: JSON.stringify({ mode }) });
            return `Results ${mode === "off" ? "unpublished" : `published — ${mode}`}`;
        });

    const showSource = async (which: "live" | "stored") => {
        setSource(which);
        setErr("");
        try {
            await loadPreview(which);
        } catch (e: any) {
            setErr(e.message);
        }
    };

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
                Pull the standings from RaceResult, then choose what a reader is served
            </p>
            <EventPicker eventId={eventId} segment="results" />

            {msg && <div className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">{msg}</div>}
            <ErrorNote msg={err} />

            {state && !state.resultsConfigured && (
                <div className="mt-4 rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm text-fog">
                    This event has no results endpoint yet. Set one on{" "}
                    <Link href={`/hyfitgames/admin/events/${eventId}/operations`} className="font-bold text-chalk underline">
                        Operations
                    </Link>{" "}
                    — it is its own RaceResult Custom API key, separate from the participant one.
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
                        /* Always rendered, disabled when there is nothing to
                           clear. A control that appears only once it has
                           something to do is a control an operator cannot find
                           when they go looking for it. */
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
                />
                <Card
                    title="Athletes"
                    body={state?.stored.athletes ? `${state.stored.athletes} on the start list` : "No start list imported"}
                    hint="From the participant endpoint"
                    action="Import athletes"
                    busy={busy === "athletes"}
                    disabled={!state?.participantConfigured || !!busy}
                    onClick={importAthletes}
                />
            </div>

            {/* ---------------------------------------------------------- mode */}
            <h2 className="mt-8 text-sm font-bold uppercase tracking-wide">What the public sees</h2>
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
                        <table className="w-full min-w-[720px] text-sm">
                            <thead className="bg-coal text-xs uppercase tracking-wider text-fog">
                                <tr>
                                    <th className="px-3 py-2 text-left">#</th>
                                    <th className="px-3 py-2 text-left">Bib</th>
                                    <th className="px-3 py-2 text-left">Name</th>
                                    <th className="px-3 py-2 text-left">Category</th>
                                    <th className="px-3 py-2 text-left">Club</th>
                                    <th className="px-3 py-2 text-right">Total</th>
                                    <th className="px-3 py-2 text-right">Team</th>
                                    <th className="px-3 py-2 text-left">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {payload.rows.map((r) => (
                                    <RowLines
                                        key={rowKey(r)}
                                        row={r}
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

/* One athlete: the standings line, and their circuit underneath it when opened.
 * The splits are a second <tr> rather than a nested table so the columns stay
 * aligned with the row they belong to. */
function RowLines({ row, open, onToggle }: { row: Row; open: boolean; onToggle: () => void }) {
    return (
        <>
            <tr onClick={onToggle} className="cursor-pointer border-t border-smoke hover:bg-coal">
                <td className="px-3 py-2 text-fog">{row.rank ?? "—"}</td>
                <td className="px-3 py-2 font-mono">{row.bib}</td>
                <td className="px-3 py-2 font-medium">{row.name || "—"}</td>
                <td className="px-3 py-2 text-fog">{row.category ?? "—"}</td>
                <td className="px-3 py-2 text-fog">{row.club ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtMs(row.total_ms)}</td>
                {/* A team time is the pair's, and only a pair has one — which
                    makes it the "raced as a team" flag as well as a number. */}
                <td className="px-3 py-2 text-right font-mono text-fog">{fmtMs(row.team_time_ms)}</td>
                {/* statusChip, not a chip of our own: REG/FIN/DNF/DNS/DQ is the
                    same vocabulary the rest of the console renders, and a
                    second mapping of it would drift. */}
                <td className="px-3 py-2">{statusChip(row.status)}</td>
            </tr>
            {open && (
                <tr className="border-t border-smoke bg-coal/50">
                    {/* The same timeline the athlete is looking at, from the
                        same component: an operator checking a suspect split
                        should be reading exactly what the athlete reads. */}
                    <td colSpan={8} className="px-3 py-4">
                        <div className="max-w-2xl">
                            <SplitTimeline source={row} />
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
}
