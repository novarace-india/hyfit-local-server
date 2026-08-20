"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { judgeApi, appPath, fmtEventDays, eventDayCount } from "../../../lib/api";
import { Spinner, Chip, ErrorNote, Empty } from "../../../lib/ui";
import { useFieldSession } from "../../../lib/field-session";

/* The console's Events screen.
 *
 * One list, from one place: hyfit_v2, through /api/hyfit-judge/admin/events.
 *
 * It used to fetch a second list from the athlete platform and merge the two by
 * id — an event had a public face (city, edition, results status) and an
 * operational one, and both were managed here. That half is gone. The platform
 * list came from the `hyfit` schema, which this deployment does not have, so it
 * answered 500 and took the whole screen with it; and an event's public
 * listing is not something field operations should be editing anyway.
 *
 * What is left is what running an event actually needs: which events exist,
 * which one the field apps are pointed at, and the way in to staffing and
 * configuring each.
 */

type EventRow = {
    id: string;
    name: string;
    venue: string;
    status: string;
    is_active: boolean;
    starts_at: string | null;
    ends_at: string | null;
    // The days the event runs on, as calendar days (YYYY-MM-DD). Day 1 and the
    // last day; event_end_date is null on a single-day event.
    event_date: string | null;
    event_end_date: string | null;
    timezone: string;
    platformEventId: string | null;
    // What this event is publishing to athletes: nothing, the cached RaceResult
    // pull, or the results stored in the database. Written through
    // PUT /admin/results/mode, which owns the column.
    results_mode: "off" | "live" | "stored";
    results_stored_at: string | null;
};

/* What a delete would take with it, from GET /admin/events/delete-impact.
 * `counts` is keyed by table, and only the tables this deployment actually has
 * are in it — see EVENT_OWNED_TABLES on the server. */
type DeleteImpact = {
    event: {
        id: string;
        name: string;
        venue: string | null;
        status: string;
        is_active: boolean;
        event_date: string | null;
        results_mode: string;
    };
    counts: Record<string, number>;
    staff: { name: string; role: string }[];
};

/** Table key → what an organiser calls it. Anything unlisted is shown as-is. */
const COUNT_LABEL: Record<string, string> = {
    athletes: "athletes on the roster",
    results: "results",
    certificateTemplates: "certificate designs",
    raceResultConfigs: "RaceResult configurations",
    syncCredentials: "sync credentials",
    pushTargets: "sync connections",
    pushRuns: "sync runs",
    staffAccounts: "staff accounts",
    auditEntries: "audit entries",
};

const STATUSES = ["draft", "ready", "live", "closed", "archived"];

/* What the stored status is CALLED on this screen.
 *
 * `closed` is the operational word — hyfit_v2.events.status has been
 * draft/ready/live/closed/archived since 080 and the athlete platform's own
 * vocabulary, which had a literal 'completed', died with the `hyfit` schema. An
 * organiser does not say a race was closed, they say it is done, so the column
 * keeps its word and the screen uses theirs. One map, so the chip, the filter
 * row and the button cannot drift apart.
 */
const STATUS_LABEL: Record<string, string> = { closed: "completed" };
const label = (status: string) => STATUS_LABEL[status] ?? status;

/** Statuses that put an event in an athlete's history rather than their diary. */
const isDone = (status: string) => status === "closed" || status === "archived";

/* When the event runs, in one line.
 *
 * The DAYS lead, because that is what an organiser scanning this list is
 * looking for and because a two-day edition has no single start instant worth
 * showing above them. `starts_at` follows as the time of day when there is one
 * — it is the gun time for Day 1, not the span, and showing it alone was what
 * made every two-day event on this screen read as a one-day event.
 */
function when(row: EventRow) {
    const days = fmtEventDays(row.event_date, row.event_end_date);
    const count = eventDayCount(row.event_date, row.event_end_date);
    const span = days && count > 1 ? `${days} · ${count} days` : days;
    const time = row.starts_at
        ? `${new Date(row.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${row.timezone}`
        : "";
    if (span && time) return `${span} · from ${time}`;
    if (span) return span;
    // No calendar day at all, which is the state every event created before
    // Day 1 became a field is in. The instant is all there is to say.
    if (row.starts_at) return `${new Date(row.starts_at).toLocaleString()} · ${row.timezone}`;
    return "No schedule set";
}

export default function AdminEvents() {
    const { user: fieldUser, ready: fieldReady } = useFieldSession();
    const [rows, setRows] = useState<EventRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [role, setRole] = useState<"prod" | "local">("prod");
    const [filter, setFilter] = useState("all");
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");
    // Which row is mid-action. Going live is three calls, so the button has to
    // say so rather than looking ignored for a second and a half.
    const [busy, setBusy] = useState("");
    // The row whose completion has been asked for but not yet confirmed. Only
    // set when there is something worth warning about — see markCompleted.
    const [confirming, setConfirming] = useState("");
    // The row being deleted, what that would remove, and the name typed to
    // confirm it. Separate from `confirming` on purpose: completing an event is
    // reversible with the Reopen button beside it, and this is not reversible
    // at all, so the two must never share a confirmation.
    const [deleting, setDeleting] = useState<DeleteImpact | null>(null);
    const [typedName, setTypedName] = useState("");
    // The row whose dates are open for editing. Creation asks for them once,
    // and every event that existed before a second day was storable has to be
    // able to acquire one without being recreated.
    const [scheduling, setScheduling] = useState("");

    const load = useCallback(async () => {
        setErr("");
        try {
            const data = await judgeApi<{ events: EventRow[]; role?: "prod" | "local" }>("/admin/events");
            setRows(data.events ?? []);
            // Which deployment this is, so the button says what it does. A
            // venue laptop does not CREATE events — it pairs with one that
            // already exists on prod, and the pairing is what creates the local
            // row. See migration 093.
            setRole(data.role === "local" ? "local" : "prod");
        } catch (e: any) {
            // Said out loud rather than swallowed. A failure here used to leave
            // the screen looking merely empty, which is indistinguishable from
            // an installation that has no events yet.
            setErr(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!fieldReady) return;
        if (fieldUser) void load();
        else setLoading(false);
    }, [fieldReady, fieldUser, load]);

    const patch = async (row: EventRow, body: Record<string, unknown>, note: string) => {
        setErr("");
        try {
            await judgeApi("/admin/events", {
                method: "PATCH",
                body: JSON.stringify({ id: row.id, ...body }),
            });
            setMsg(note);
            setTimeout(() => setMsg(""), 3000);
            await load();
        } catch (e: any) {
            setErr(e.message);
        }
    };

    /* Go live: one button, three things, in the order that keeps them honest.
     *
     *   1. the event is running        PATCH status = live
     *   2. there are standings to show POST results/pull  (into the cache)
     *   3. athletes may see them       PUT  results/mode = live
     *
     * The pull comes BEFORE the mode. Flipping the mode first would publish an
     * empty board — the athlete pages read the cache, and a live event with
     * nothing cached shows "no results published" to everyone who looks. If the
     * pull fails (usually no results endpoint configured yet), the event is
     * still live operationally and the error says what is missing, which is the
     * true state of things rather than a half-published race.
     */
    const goLive = async (row: EventRow) => {
        setBusy(row.id);
        setErr("");
        setMsg("");
        try {
            if (row.status !== "live") {
                await judgeApi("/admin/events", {
                    method: "PATCH",
                    body: JSON.stringify({ id: row.id, status: "live" }),
                });
            }
            const pulled = await judgeApi<{ rows: unknown[] }>(
                `/admin/results/pull?eventId=${encodeURIComponent(row.id)}`,
                { method: "POST", body: JSON.stringify({ store: false }) },
            );
            await judgeApi(`/admin/results/mode?eventId=${encodeURIComponent(row.id)}`, {
                method: "PUT",
                body: JSON.stringify({ mode: "live" }),
            });
            setMsg(`${row.name} is live · ${pulled.rows.length} results published to athletes`);
            setTimeout(() => setMsg(""), 4000);
            await load();
        } catch (e: any) {
            setErr(e.message);
            await load();
        } finally {
            setBusy("");
        }
    };

    /* Re-pull the feed for an event that is already live. The mode is untouched
     * — it is already 'live' — so this is only ever "the standings moved on". */
    const refreshLive = async (row: EventRow) => {
        setBusy(row.id);
        setErr("");
        setMsg("");
        try {
            const pulled = await judgeApi<{ rows: unknown[] }>(
                `/admin/results/pull?eventId=${encodeURIComponent(row.id)}`,
                { method: "POST", body: JSON.stringify({ store: false }) },
            );
            setMsg(`${row.name} · ${pulled.rows.length} results refreshed`);
            setTimeout(() => setMsg(""), 4000);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
        }
    };

    /* Empty this event's cached pull. Separate from Stop on purpose: Stop
     * unpublishes and leaves the rows there to publish again, this throws the
     * rows away and leaves the switch alone. An event still in live mode after
     * this shows athletes nothing until the next pull, which the message says
     * out loud. */
    const clearCache = async (row: EventRow) => {
        setBusy(row.id);
        setErr("");
        setMsg("");
        try {
            await judgeApi(`/admin/results/discard?eventId=${encodeURIComponent(row.id)}`, {
                method: "POST",
                body: JSON.stringify({}),
            });
            setMsg(
                row.results_mode === "live"
                    ? `${row.name} · cache cleared — athletes see no results until the next pull`
                    : `${row.name} · cache cleared`,
            );
            setTimeout(() => setMsg(""), 4000);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
        }
    };

    /* Completing an event: the ONLY thing that moves it out of an athlete's
     * "upcoming" list.
     *
     * GET /api/hyfitgames/me/events sorts a person's races on this column and
     * nothing else — draft/ready/live are upcoming, closed/archived are past.
     * Until this button there was no writer of any value but 'live', so every
     * race ever run stayed listed as upcoming to everyone on its start list,
     * days after it finished.
     *
     * results_mode is deliberately left alone, for the same reason Stop leaves
     * the status alone: what the crew is doing and what athletes can see are
     * two facts, and one button that quietly did both would make the pair
     * impossible to hold apart. But an event completed with its results
     * unpublished hands every athlete a history row with no time on it — the
     * results join in hfg-athlete.controller is gated on
     * results_mode = 'stored' — so that case, and an event the tablets are
     * still pointed at, are said out loud BEFORE the press rather than
     * discovered afterwards by the athletes.
     */
    const needsWarning = (row: EventRow) => row.results_mode !== "stored" || row.is_active;

    const completeNow = async (row: EventRow) => {
        setConfirming("");
        setBusy(row.id);
        try {
            await patch(row, { status: "closed" }, `${row.name} is completed — athletes now see it in their history`);
        } finally {
            setBusy("");
        }
    };

    const markCompleted = async (row: EventRow) => {
        if (needsWarning(row) && confirming !== row.id) {
            setErr("");
            setConfirming(row.id);
            return;
        }
        await completeNow(row);
    };

    /* Completed by mistake, or completed and then reopened for a late heat.
     * Back to 'live' rather than to whatever it was before: the status is not
     * versioned, and an event being reopened is being run. */
    const reopen = async (row: EventRow) => {
        setBusy(row.id);
        try {
            await patch(row, { status: "live" }, `${row.name} is live again`);
        } finally {
            setBusy("");
        }
    };

    /* Stop publishing without touching the event's own status: a race can still
     * be running while the organiser takes a wrong board down. */
    const stopPublishing = async (row: EventRow) => {
        setBusy(row.id);
        setErr("");
        try {
            await judgeApi(`/admin/results/mode?eventId=${encodeURIComponent(row.id)}`, {
                method: "PUT",
                body: JSON.stringify({ mode: "off" }),
            });
            setMsg(`${row.name} results are no longer published`);
            setTimeout(() => setMsg(""), 3000);
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
        }
    };

    /* Deleting an event: ask the server what that means, THEN ask the operator.
     *
     * The confirmation is not written here — the numbers in it come from the
     * database, because "delete this event?" and "delete this event, its 3 214
     * athletes, its results and the six staff accounts hired for it?" are
     * different questions, and only the second one can be answered honestly. */
    const startDelete = async (row: EventRow) => {
        setErr("");
        setBusy(row.id);
        try {
            const impact = await judgeApi<DeleteImpact>(
                `/admin/events/delete-impact?eventId=${encodeURIComponent(row.id)}`,
            );
            setTypedName("");
            setConfirming("");
            setDeleting(impact);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
        }
    };

    const confirmDelete = async () => {
        if (!deleting) return;
        const { id, name } = deleting.event;
        setErr("");
        setBusy(id);
        try {
            await judgeApi(
                `/admin/events?eventId=${encodeURIComponent(id)}&confirm=${encodeURIComponent(typedName)}`,
                { method: "DELETE" },
            );
            setDeleting(null);
            setTypedName("");
            setMsg(`"${name}" and everything belonging to it has been deleted`);
            setTimeout(() => setMsg(""), 6000);
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
        }
    };

    if (!fieldReady || loading) return <Spinner />;

    if (!fieldUser) {
        return (
            <div>
                <h1 className="text-2xl font-black uppercase tracking-wide">Events</h1>
                <p className="mt-1 text-sm text-fog">Field operations for every event</p>
                <p className="mt-4 rounded-lg border border-smoke bg-coal px-3 py-2 text-sm text-fog">
                    Your console login is not linked to a field account, so there is nothing to show here.
                </p>
            </div>
        );
    }

    const filtered = filter === "all" ? rows : rows.filter((r) => r.status === filter);
    const countFor = (s: string) => rows.filter((r) => r.status === s).length;

    return (
        <div>
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-black uppercase tracking-wide">Events</h1>
                    <p className="mt-1 text-sm text-fog">Field operations for every event</p>
                </div>
                <button
                    onClick={() => setShowCreate(!showCreate)}
                    className="rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill"
                >
                    {showCreate ? "Cancel" : role === "local" ? "+ Add Event From Prod" : "+ New Event"}
                </button>
            </div>

            {showCreate &&
                (role === "local" ? (
                    <PairEvent
                        onDone={() => {
                            setShowCreate(false);
                            void load();
                        }}
                    />
                ) : (
                    <CreateEvent
                        onDone={() => {
                            setShowCreate(false);
                            void load();
                        }}
                    />
                ))}

            {msg && <div className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">{msg}</div>}
            <ErrorNote msg={err} />

            <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
                {["all", ...STATUSES].map((s) => (
                    <button
                        key={s}
                        onClick={() => setFilter(s)}
                        className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide transition ${
                            filter === s ? "bg-hyred text-onfill" : "border border-smoke text-fog hover:text-chalk"
                        }`}
                    >
                        {label(s)} {s !== "all" && `(${countFor(s)})`}
                    </button>
                ))}
            </div>

            {filtered.length === 0 ? (
                <Empty title="No events found" hint="Create your first event above" />
            ) : (
                <div className="mt-4 space-y-2">
                    {filtered.map((row) => (
                        <div key={row.id} className="rounded-xl border border-smoke bg-coal p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        {/* The way in. Operations is the event's
                                            home — its RaceResult wiring, its
                                            check-in window — and the row's other
                                            links are shortcuts past it. The name
                                            being dead text was the reason people
                                            went looking for a way to open an
                                            event and found none. */}
                                        <Link
                                            href={appPath(`/hyfitgames/admin/events/${row.id}/operations`)}
                                            className="font-bold underline-offset-4 hover:text-hyred hover:underline"
                                        >
                                            {row.name}
                                        </Link>
                                        {row.is_active && <Chip tone="live">Active</Chip>}
                                        <Chip tone={row.status === "live" ? "live" : isDone(row.status) ? "ok" : "default"}>
                                            {label(row.status)}
                                        </Chip>
                                        {/* What athletes can see right now. The
                                            event's own status says the crew is
                                            running it; this says the standings
                                            are on their phones. */}
                                        {row.results_mode === "live" && <Chip tone="live">Live results</Chip>}
                                        {row.results_mode === "stored" && <Chip tone="ok">Results published</Chip>}
                                    </div>
                                    <p className="mt-1 text-xs text-fog">
                                        {when(row)} · {row.venue || "Venue TBD"}
                                    </p>
                                </div>

                                <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                                    {/* Which event the field apps are pointed at. A
                                        staff account with no event of its own
                                        resolves to the active one, so somebody has
                                        to say which. */}
                                    {/* The day's main control. One press puts
                                        the event live, pulls the standings into
                                        the cache and publishes them to
                                        /hyfitgames — see goLive. */}
                                    {row.results_mode === "live" ? (
                                        <>
                                            <button
                                                disabled={busy === row.id}
                                                onClick={() => void refreshLive(row)}
                                                className="rounded-lg bg-hyred px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                                            >
                                                {busy === row.id ? "Refreshing…" : "Refresh results"}
                                            </button>
                                            <button
                                                disabled={busy === row.id}
                                                onClick={() => void clearCache(row)}
                                                className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                                            >
                                                Clear cache
                                            </button>
                                            <button
                                                disabled={busy === row.id}
                                                onClick={() => void stopPublishing(row)}
                                                className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                                            >
                                                Stop
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            disabled={busy === row.id}
                                            onClick={() => void goLive(row)}
                                            className="rounded-lg bg-hyred px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                                        >
                                            {busy === row.id ? "Going live…" : "Go live"}
                                        </button>
                                    )}
                                    {/* The end of the day. Nothing else moves an
                                        event out of an athlete's upcoming list
                                        — see markCompleted. */}
                                    {isDone(row.status) ? (
                                        <button
                                            disabled={busy === row.id}
                                            onClick={() => void reopen(row)}
                                            className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                                        >
                                            Reopen
                                        </button>
                                    ) : (
                                        <button
                                            disabled={busy === row.id}
                                            onClick={() => void markCompleted(row)}
                                            className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                                        >
                                            Mark completed
                                        </button>
                                    )}
                                    <button
                                        disabled={row.is_active}
                                        onClick={() =>
                                            void patch(row, { activate: true }, `${row.name} is now the active event`)
                                        }
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                                    >
                                        {row.is_active ? "Active" : "Make active"}
                                    </button>
                                    {/* The event's days. On the row rather than
                                        on Operations because that screen is the
                                        RaceResult wiring, and because this list
                                        is where the dates are read — the place
                                        somebody notices Day 2 is missing is the
                                        place they should be able to add it. */}
                                    <button
                                        onClick={() => setScheduling(scheduling === row.id ? "" : row.id)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                    >
                                        {scheduling === row.id ? "Close" : "Dates"}
                                    </button>
                                    <Link
                                        href={appPath(`/hyfitgames/admin/events/${row.id}/operations`)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                    >
                                        Operations
                                    </Link>
                                    <Link
                                        href={appPath(`/hyfitgames/admin/events/${row.id}/athletes`)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                    >
                                        Athletes
                                    </Link>
                                    <Link
                                        href={appPath(`/hyfitgames/admin/events/${row.id}/results`)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                    >
                                        Results
                                    </Link>
                                    <Link
                                        href={appPath(`/hyfitgames/admin/events/${row.id}/team`)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                    >
                                        Team
                                    </Link>
                                    {/* Offline events only in practice, but the
                                        link is always here: it is also where an
                                        event is MADE offline, and a control that
                                        only appears once it has been used is a
                                        control nobody can find the first time. */}
                                    <Link
                                        href={appPath(`/hyfitgames/admin/events/${row.id}/sync`)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                    >
                                        Sync
                                    </Link>
                                    {/* Last in the row, and only for a
                                        super_admin — the server enforces that,
                                        this only keeps a button nobody may use
                                        off an event_admin's screen. Outlined in
                                        the warning colour rather than filled:
                                        it must be findable, and it must not sit
                                        on the row looking like the day's main
                                        control. */}
                                    {fieldUser.role === "super_admin" && (
                                        <button
                                            disabled={busy === row.id}
                                            onClick={() => void startDelete(row)}
                                            className="rounded-lg border border-bad/50 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-bad hover:bg-hyred/10 disabled:opacity-40"
                                        >
                                            {busy === row.id && deleting?.event.id === row.id ? "…" : "Delete"}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {scheduling === row.id && (
                                <ScheduleEditor
                                    row={row}
                                    onCancel={() => setScheduling("")}
                                    onSaved={async (note) => {
                                        setScheduling("");
                                        setMsg(note);
                                        setTimeout(() => setMsg(""), 3000);
                                        await load();
                                    }}
                                />
                            )}

                            {/* Inline rather than a browser confirm(): the
                                reasons are specific to this row, and an
                                organiser deciding whether to complete a race
                                needs to see WHICH of them applies. */}
                            {confirming === row.id && (
                                <div className="mt-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
                                    <p className="font-bold uppercase tracking-wide">Complete {row.name}?</p>
                                    <ul className="mt-1 list-disc space-y-1 pl-4">
                                        {row.results_mode !== "stored" && (
                                            <li>
                                                Results are not published, so every athlete on the start
                                                list gets this race in their history with no time against
                                                it. Publish the results first if they should keep one.
                                            </li>
                                        )}
                                        {row.is_active && (
                                            <li>
                                                The field apps are still pointed at this event as the
                                                active one. Make another event active before the next
                                                race day.
                                            </li>
                                        )}
                                    </ul>
                                    <div className="mt-2 flex gap-2">
                                        <button
                                            disabled={busy === row.id}
                                            onClick={() => void completeNow(row)}
                                            className="rounded-lg bg-hyred px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                                        >
                                            {busy === row.id ? "Completing…" : "Complete anyway"}
                                        </button>
                                        <button
                                            onClick={() => setConfirming("")}
                                            className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}

                            {deleting?.event.id === row.id && (
                                <DeleteConfirm
                                    impact={deleting}
                                    typedName={typedName}
                                    onType={setTypedName}
                                    busy={busy === row.id}
                                    onCancel={() => {
                                        setDeleting(null);
                                        setTypedName("");
                                    }}
                                    onConfirm={() => void confirmDelete()}
                                />
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/* The one confirmation on this screen that cannot be undone.
 *
 * It states what goes, in rows, from the server's own count — and names the
 * staff accounts, because those are people who will try to sign in on race
 * morning. The name has to be typed: two editions of the same race sit next to
 * each other in this list, and nothing here is recoverable afterwards.
 */
function DeleteConfirm({
    impact,
    typedName,
    onType,
    busy,
    onCancel,
    onConfirm,
}: {
    impact: DeleteImpact;
    typedName: string;
    onType: (value: string) => void;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const { event, counts, staff } = impact;
    // Only what is actually there. A list of nine zeroes reads as boilerplate,
    // and the two lines that matter get lost in it.
    const removals = Object.entries(counts).filter(([, n]) => n > 0);
    const matches = typedName.trim().replace(/\s+/g, " ").toLowerCase() === event.name.trim().replace(/\s+/g, " ").toLowerCase();

    return (
        <div className="mt-3 rounded-lg border border-bad/50 bg-hyred/10 px-3 py-3 text-xs">
            <p className="font-bold uppercase tracking-wide text-bad">Delete {event.name} permanently?</p>

            {event.is_active ? (
                <p className="mt-2 text-fog">
                    This is the active event — the tablets and check-in counters are running it. Make another event
                    active first; the server will refuse until you do.
                </p>
            ) : (
                <>
                    <p className="mt-2 text-fog">
                        {removals.length
                            ? "This removes, permanently and with no undo:"
                            : "There is nothing attached to this event yet — only the event itself goes."}
                    </p>
                    {removals.length > 0 && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-fog">
                            {removals.map(([key, n]) => (
                                <li key={key}>
                                    <span className="font-bold text-chalk">{n.toLocaleString()}</span>{" "}
                                    {COUNT_LABEL[key] ?? key}
                                </li>
                            ))}
                        </ul>
                    )}
                    {event.results_mode !== "off" && (
                        <p className="mt-2 text-fog">
                            This event is publishing its leaderboard right now. Anyone reading it — athletes, families,
                            the venue screen — loses it the moment this is deleted.
                        </p>
                    )}
                    {staff.length > 0 && (
                        <p className="mt-2 text-fog">
                            The staff accounts hired for this event go with it — {staff.map((s) => `${s.name} (${s.role})`).join(", ")}
                            {counts.staffAccounts > staff.length ? `, and ${counts.staffAccounts - staff.length} more` : ""}. They
                            will not be able to sign in to the judge or check-in apps. Console operators, who work every
                            event, are not affected.
                        </p>
                    )}
                </>
            )}

            <label className="mt-3 block font-bold uppercase tracking-wider text-fog">
                Type the event name to confirm
            </label>
            <input
                value={typedName}
                onChange={(e) => onType(e.target.value)}
                placeholder={event.name}
                disabled={event.is_active}
                className="mt-1 w-full max-w-sm rounded-lg border border-smoke bg-coal px-3 py-2 text-sm outline-none focus:border-hyred disabled:opacity-40"
            />

            <div className="mt-3 flex gap-2">
                <button
                    disabled={busy || !matches || event.is_active}
                    onClick={onConfirm}
                    className="rounded-lg bg-hyred px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                >
                    {busy ? "Deleting…" : "Delete this event"}
                </button>
                <button
                    onClick={onCancel}
                    className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

function CreateEvent({ onDone }: { onDone: () => void }) {
    const [form, setForm] = useState({
        name: "",
        venue: "",
        eventDate: "",
        eventEndDate: "",
        startsAt: "",
        timezone: "Asia/Kolkata",
        // Where this event's public read is served from. Asked HERE since 093
        // rather than on the Sync screen afterwards: it is a decision made when
        // the event is planned, and the symptom of forgetting to go and flip it
        // later is discovered at a venue, by an operator whose pasted sync URL
        // is refused because prod still has the event down as online.
        deliveryMode: "online",
    });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
            // The field module's own route: an operational event and nothing
            // else. Stations and categories are not asked for — they belonged
            // to the athlete platform's entry flow, and the field apps take
            // their roster from RaceResult.
            await judgeApi("/admin/events", {
                method: "POST",
                body: JSON.stringify({
                    name: form.name,
                    venue: form.venue,
                    eventDate: form.eventDate || null,
                    // Left blank for a one-day event. The server stores blank
                    // and "same as Day 1" identically, as NULL.
                    eventEndDate: form.eventEndDate || null,
                    startsAt: form.startsAt || null,
                    timezone: form.timezone,
                    deliveryMode: form.deliveryMode,
                }),
            });
            onDone();
        } catch (e: any) {
            setErr(e.message);
            setBusy(false);
        }
    };

    const input = (key: keyof typeof form, label: string, type = "text", opts: any = {}) => (
        <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">{label}</label>
            <input
                type={type}
                value={form[key]}
                {...opts}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm outline-none focus:border-hyred"
            />
        </div>
    );

    return (
        <div className="mt-4 rounded-xl border border-smoke bg-coal p-5">
            <h3 className="text-sm font-bold uppercase tracking-wide">Create New Event</h3>
            <p className="mt-1 text-xs text-fog">
                Creates the operational event. Point it at RaceResult on its Operations screen, then staff it on Team.
            </p>
            <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
                {input("name", "Event Name", "text", { required: true, placeholder: "HYFIT Games Mumbai" })}
                {input("venue", "Venue", "text", { placeholder: "Wankhede Sports Complex" })}
                {/* Day 1. The check-in window anchors an athlete's timeslot
                    to it for anyone whose RaceResult ContestDate is blank — on
                    a single-day event, everyone. */}
                {input("eventDate", "Day 1", "date", { max: form.eventEndDate || undefined })}
                {/* Day 2, and the reason this pair exists: an edition running
                    over a weekend showed only its Saturday everywhere, and read
                    as an event that was over that evening. Optional, because a
                    one-day event is not a two-day event with the second day
                    repeated. */}
                {input("eventEndDate", "Last Day (multi-day events)", "date", {
                    min: form.eventDate || undefined,
                    disabled: !form.eventDate,
                })}
                {input("startsAt", "Starts At", "datetime-local")}
                {input("timezone", "Timezone", "text", { placeholder: "Asia/Kolkata" })}

                {/* Online or offline: the one question on this form that is not
                    about the race. Two radios rather than a checkbox because
                    "offline" is not the absence of "online" — they are two ways
                    of running an event, and a cleared checkbox says neither. */}
                <fieldset className="sm:col-span-2 rounded-lg border border-smoke p-3">
                    <legend className="px-1 text-xs font-bold uppercase tracking-wider text-fog">
                        How is it run?
                    </legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {(
                            [
                                {
                                    value: "online",
                                    title: "Online",
                                    blurb: "The crew works in this deployment and it publishes the results itself. Nothing else to set up.",
                                },
                                {
                                    value: "offline",
                                    title: "Offline (local server at the venue)",
                                    blurb: "A laptop on the venue's network runs check-in and judging. It pulls this event's setup from here and pushes the standings back.",
                                },
                            ] as const
                        ).map((option) => (
                            <label
                                key={option.value}
                                className={`cursor-pointer rounded-lg border p-3 ${
                                    form.deliveryMode === option.value
                                        ? "border-hyred bg-hyred/10"
                                        : "border-smoke hover:border-fog"
                                }`}
                            >
                                <span className="flex items-center gap-2">
                                    <input
                                        type="radio"
                                        name="deliveryMode"
                                        value={option.value}
                                        checked={form.deliveryMode === option.value}
                                        onChange={() => setForm({ ...form, deliveryMode: option.value })}
                                        className="accent-hyred"
                                    />
                                    <span className="text-sm font-bold">{option.title}</span>
                                </span>
                                <span className="mt-1 block text-xs text-fog">{option.blurb}</span>
                            </label>
                        ))}
                    </div>
                    {form.deliveryMode === "offline" && (
                        <p className="mt-2 text-xs text-fog">
                            Once it is created, open its <strong className="text-chalk">Sync</strong> screen to issue the
                            URL the venue laptop pastes.
                        </p>
                    )}
                </fieldset>
                {form.eventDate && form.eventEndDate && form.eventEndDate > form.eventDate && (
                    <p className="text-xs text-fog sm:col-span-2">
                        Runs over {eventDayCount(form.eventDate, form.eventEndDate)} days ·{" "}
                        {fmtEventDays(form.eventDate, form.eventEndDate)}
                    </p>
                )}
                <div className="sm:col-span-2 flex items-center gap-3">
                    <button
                        type="submit"
                        disabled={busy || !form.name.trim()}
                        className="rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide disabled:opacity-40 text-onfill"
                    >
                        {busy ? "Creating…" : "Create Event"}
                    </button>
                    <ErrorNote msg={err} />
                </div>
            </form>
        </div>
    );
}

/* The event's days, edited in place on its row.
 *
 * Two fields and nothing else. It deliberately does not offer the start INSTANT
 * or the timezone: those belong to a schedule, and the thing an organiser comes
 * to this control for is "this edition runs Saturday AND Sunday". Widening it
 * to the whole event would make a control people open to check a date into one
 * they can accidentally rename an event with.
 *
 * PATCH sends both keys every time, including as null. The route treats a key
 * that is present as an instruction and a key that is absent as "leave it" —
 * which is the only way to take a wrongly-added second day back off again.
 */
function ScheduleEditor({
    row,
    onCancel,
    onSaved,
}: {
    row: EventRow;
    onCancel: () => void;
    onSaved: (note: string) => void | Promise<void>;
}) {
    // Sliced because a `date` column that ever reaches this screen as a full
    // timestamp would not fit the input's YYYY-MM-DD value at all, and the
    // field would silently render empty over a date that is really stored.
    const [day1, setDay1] = useState((row.event_date ?? "").slice(0, 10));
    const [lastDay, setLastDay] = useState((row.event_end_date ?? "").slice(0, 10));
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");

    const invalid = !day1 && !!lastDay ? "A last day needs a Day 1 as well" :
        day1 && lastDay && lastDay < day1 ? "The last day cannot be before Day 1" : "";

    const save = async () => {
        setBusy(true);
        setErr("");
        try {
            await judgeApi("/admin/events", {
                method: "PATCH",
                body: JSON.stringify({
                    id: row.id,
                    eventDate: day1 || null,
                    eventEndDate: lastDay || null,
                }),
            });
            await onSaved(`${row.name} · dates updated`);
        } catch (e: any) {
            setErr(e.message);
            setBusy(false);
        }
    };

    const field = (label: string, value: string, set: (v: string) => void, opts: any = {}) => (
        <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">{label}</label>
            <input
                type="date"
                value={value}
                {...opts}
                onChange={(e) => set(e.target.value)}
                className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
            />
        </div>
    );

    return (
        <div className="mt-3 rounded-lg border border-smoke bg-ink/60 px-3 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-fog">Event days</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {field("Day 1", day1, setDay1, { max: lastDay || undefined })}
                {field("Last Day (multi-day events)", lastDay, setLastDay, {
                    min: day1 || undefined,
                    disabled: !day1,
                })}
            </div>
            <p className="mt-2 text-xs text-fog">
                {invalid ? (
                    <span className="text-bad">{invalid}</span>
                ) : day1 ? (
                    <>
                        Shown to athletes as{" "}
                        <span className="font-bold text-chalk">{fmtEventDays(day1, lastDay)}</span>
                        {eventDayCount(day1, lastDay) > 1
                            ? ` · ${eventDayCount(day1, lastDay)} days`
                            : ""}
                    </>
                ) : (
                    "Leave the last day blank for a single-day event."
                )}
            </p>
            <div className="mt-3 flex items-center gap-2">
                <button
                    disabled={busy || !!invalid}
                    onClick={() => void save()}
                    className="rounded-lg bg-hyred px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                >
                    {busy ? "Saving…" : "Save dates"}
                </button>
                <button
                    onClick={onCancel}
                    className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                >
                    Cancel
                </button>
                <ErrorNote msg={err} />
            </div>
        </div>
    );
}

/* Adding an event on a venue laptop: paste the URL, and the event arrives.
 *
 * THERE IS NO FORM HERE, AND THAT IS THE FEATURE. Everything a "create event"
 * form would ask for — the name, the venue, the dates, the timezone — has
 * already been typed once, on prod, by whoever planned the race. Asking for it
 * again at the venue produced two events that agreed only by luck, and the
 * disagreements surfaced at the worst time: an operator looking at a laptop
 * that said one date and a public site that said another.
 *
 * So the only input is the URL prod issued. The server handshakes with prod,
 * creates the local event UNDER PROD'S OWN ID, and pulls the whole
 * configuration down in the same call. One event, in two places, with one id
 * and one set of facts.
 *
 * WHY THE REDIRECT IS CLIENT-SIDE. `next/navigation`'s `redirect()` does not
 * work inside `admin/(panel)`: that layout is a client component rendering a
 * spinner until the session check passes, so a redirect thrown by a child that
 * has not rendered never reaches the response and the route quietly returns
 * 200. `router.push` is what actually moves.
 */
function PairEvent({ onDone }: { onDone: () => void }) {
    const router = useRouter();
    const [url, setUrl] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const [note, setNote] = useState("");

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        setNote("");
        try {
            const out = await judgeApi<{
                eventId: string;
                remote: { event: { name: string } };
                pullError?: string;
            }>("/admin/sync/pair", {
                method: "POST",
                body: JSON.stringify({ url, baseUrl: baseUrl.trim() || undefined }),
            });

            // A pairing that could not complete its first pull is still a
            // pairing — the credential is good and the row is written — so it
            // is reported rather than treated as a failure. The Sync screen has
            // a Pull button for exactly this.
            if (out.pullError) {
                setNote(
                    `Paired with "${out.remote?.event?.name ?? "prod"}", but the first configuration pull failed: ${out.pullError}`,
                );
                setBusy(false);
                onDone();
                return;
            }

            onDone();
            router.push(appPath(`/hyfitgames/admin/events/${out.eventId}/sync`));
        } catch (e: any) {
            setErr(e.message);
            setBusy(false);
        }
    };

    return (
        <div className="mt-4 rounded-xl border border-smoke bg-coal p-5">
            <h3 className="text-sm font-bold uppercase tracking-wide">Add an event from prod</h3>
            <p className="mt-1 text-xs text-fog">
                Paste the sync URL the prod console issued for this event. Either of the two works — they carry the
                same credential. The event, its dates, its RaceResult wiring and its check-in window all come down with
                it.
            </p>
            <form className="mt-4 space-y-3" onSubmit={submit}>
                <div>
                    <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">
                        Sync URL
                    </label>
                    <textarea
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        rows={3}
                        required
                        spellCheck={false}
                        placeholder="https://app.example.com/api/hyfit-judge/ingest/events/…/config?k=…"
                        className="w-full break-all rounded-lg border border-smoke bg-ink px-3 py-2.5 font-mono text-xs outline-none focus:border-hyred"
                    />
                    <p className="mt-1 text-xs text-fog">
                        Include the <code>?k=</code> part — it is the half that makes it work.
                    </p>
                </div>

                <div>
                    <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">
                        Server address (optional)
                    </label>
                    <input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        spellCheck={false}
                        placeholder="https://app.example.com"
                        className="w-full rounded-lg border border-smoke bg-ink px-3 py-2.5 text-sm outline-none focus:border-hyred"
                    />
                    <p className="mt-1 text-xs text-fog">
                        Only if this venue reaches prod on a different address than the URL says — a tunnel, an IP, a
                        staging host. Leave blank to use the one in the URL.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <button
                        type="submit"
                        disabled={busy || !url.trim()}
                        className="rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                    >
                        {busy ? "Pairing…" : "Pair And Pull"}
                    </button>
                    <ErrorNote msg={err} />
                </div>
                {note && <p className="text-xs text-fog">{note}</p>}
            </form>
        </div>
    );
}
