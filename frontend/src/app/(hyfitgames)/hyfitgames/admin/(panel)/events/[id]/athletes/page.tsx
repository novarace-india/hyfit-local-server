"use client";

/* The Athletes screen: the start list this event is being run on.
 *
 * One roster, imported from the event's RaceResult participant endpoint into
 * `hyfit_v2.athletes`. It is deliberately a READ of what was imported, not an
 * editor: the counters and the judge tablets resolve a bib against RaceResult
 * live, so a name edited here would be a name only this screen believes. Fix it
 * in RaceResult and import again.
 *
 * What it is for is the question an organiser actually asks on the morning of
 * an event — "is everybody in, and is the data any good?" — so the counts
 * across the top are of the fields that break something downstream when they
 * are missing: no category means no standings bucket, no timeslot means the
 * check-in window cannot refuse anybody, no mobile means the athlete cannot be
 * reached.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { judgeApi } from "../../../../../lib/api";
import { Spinner, ErrorNote, Empty, Chip } from "../../../../../lib/ui";
import { FieldSignIn, useFieldSession } from "../../../../../lib/field-session";
import EventPicker from "../event-picker";

type Athlete = {
    /** The ENTRY id (a row of athlete_events_map), not the person's. A person
     *  holding two bibs at one event is two rows here. */
    id: string;
    athlete_id: string;
    bib: string;
    name: string;
    gender: string | null;
    date_of_birth: string | null;
    age: number | null;
    mobile: string | null;
    club: string | null;
    category: string | null;
    /** The age band beneath the contest, from the feed's AgeGroup column (091).
     *  Null for a roster imported from an export that carries no such column. */
    age_group: string | null;
    contest_id: string | null;
    wave: string | null;
    timeslot: string | null;
    contest_date: string | null;
    source: string;
    updated_at: string;
    /** How many events this person has entered in total — the map made
     *  visible. A returning athlete reads differently from a first-timer. */
    events_entered: number;
};

const dash = (v: string | number | null | undefined) =>
    v === null || v === undefined || v === "" ? "—" : String(v);

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

export default function AthletesPage() {
    const { id: eventId } = useParams<{ id: string }>();
    const { user, ready } = useFieldSession();
    const scoped = (path: string) => `${path}${path.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(eventId)}`;

    const [athletes, setAthletes] = useState<Athlete[]>([]);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [importing, setImporting] = useState(false);
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");
    // Two-step, because there is no undo. The first press asks, the second
    // does it — a roster and its results are minutes of re-import away at best
    // and a race day's work at worst.
    const [confirmDelete, setConfirmDelete] = useState(false);

    const load = useCallback(async () => {
        setErr("");
        try {
            const data = await judgeApi<{ athletes: Athlete[] }>(scoped("/admin/athletes"));
            setAthletes(data.athletes ?? []);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setLoading(false);
        }
    }, [eventId]);

    // A message and a roster about the previous event do not belong on this one.
    useEffect(() => {
        setMsg("");
        setSearch("");
        setAthletes([]);
        setLoading(true);
    }, [eventId]);

    useEffect(() => {
        if (user) void load();
        else if (ready) setLoading(false);
    }, [user, ready, load]);

    /* Filtered here rather than through the search endpoint. The whole roster
       is one request and a few hundred rows, so typing filters instantly
       instead of firing a query per keystroke. The endpoint's own `q` stays for
       callers that want the server to do it. */
    const rows = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) return athletes;
        return athletes.filter((a) =>
            [a.bib, a.name, a.club, a.category, a.age_group, a.mobile]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(term)),
        );
    }, [athletes, search]);

    const gaps = useMemo(
        () => ({
            category: athletes.filter((a) => !a.category).length,
            timeslot: athletes.filter((a) => !a.timeslot).length,
            mobile: athletes.filter((a) => !a.mobile).length,
            fromResults: athletes.filter((a) => a.source === "results").length,
        }),
        [athletes],
    );

    const importAthletes = async () => {
        setImporting(true);
        setErr("");
        setMsg("");
        try {
            const out = await judgeApi<{
                imported: number;
                created: number;
                updated: number;
                removed: number;
                rejected: number;
            }>(scoped("/admin/athletes/import"), { method: "POST", body: JSON.stringify({}) });
            // `removed` is worth saying out loud: the import replaces this
            // event's roster, so a non-zero count means entries that are no
            // longer on the start list have just been deleted.
            setMsg(
                `${out.imported} rows imported · ${out.created} new, ${out.updated} updated${
                    out.removed ? ` · ${out.removed} no longer on the start list, removed` : ""
                }${out.rejected ? ` · ${out.rejected} rejected` : ""}`,
            );
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setImporting(false);
        }
    };

    const deleteAll = async () => {
        setImporting(true);
        setErr("");
        setMsg("");
        try {
            const out = await judgeApi<{ athletes: number; results: number }>(
                scoped("/admin/athletes"),
                { method: "DELETE" },
            );
            setMsg(
                `Deleted ${out.athletes} athletes${out.results ? ` and ${out.results} results` : ""} from this event`,
            );
            setConfirmDelete(false);
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setImporting(false);
        }
    };

    if (!ready || (loading && user)) return <Spinner />;

    if (!user) {
        return (
            <div>
                <h1 className="text-2xl font-black uppercase tracking-wide">Athletes</h1>
                <p className="mt-1 text-sm text-fog">The start list for this event</p>
                <FieldSignIn what="the start list" />
            </div>
        );
    }

    return (
        <div>
            <h1 className="text-2xl font-black uppercase tracking-wide">Athletes</h1>
            <p className="mt-1 text-sm text-fog">
                Imported from this event&apos;s RaceResult participant endpoint — the same feed the counters read
            </p>
            <EventPicker eventId={eventId} segment="athletes" />

            {msg && <div className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">{msg}</div>}
            <ErrorNote msg={err} />

            <div className="mt-6 flex flex-wrap items-center gap-3">
                <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search bib, name, club, category, age group or number"
                    className="min-w-64 flex-1 rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm outline-none focus:border-hyred"
                />
                <button
                    onClick={importAthletes}
                    disabled={importing}
                    className="rounded-lg bg-hyred px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                >
                    {importing ? "Importing…" : "Import from RaceResult"}
                </button>
                <Link
                    href={`/hyfitgames/admin/events/${eventId}/operations`}
                    className="rounded-lg border border-smoke px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                >
                    Endpoint
                </Link>
                {athletes.length > 0 &&
                    (confirmDelete ? (
                        <span className="flex items-center gap-2">
                            <button
                                onClick={deleteAll}
                                disabled={importing}
                                className="rounded-lg bg-hyred px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                            >
                                {importing ? "Deleting…" : `Delete all ${athletes.length}?`}
                            </button>
                            <button
                                onClick={() => setConfirmDelete(false)}
                                className="text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk"
                            >
                                Cancel
                            </button>
                        </span>
                    ) : (
                        <button
                            onClick={() => setConfirmDelete(true)}
                            className="rounded-lg border border-smoke px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-bad"
                        >
                            Delete roster
                        </button>
                    ))}
            </div>
            {confirmDelete && (
                <p className="mt-2 text-xs text-warn">
                    This removes every athlete on this event and any stored results with them. Other events are
                    untouched. Re-import from RaceResult to rebuild.
                </p>
            )}

            {athletes.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-fog">
                    <span>
                        <b className="text-chalk">{athletes.length}</b> on the roster
                        {rows.length !== athletes.length ? ` · ${rows.length} shown` : ""}
                    </span>
                    {gaps.category > 0 && <span>{gaps.category} with no category</span>}
                    {gaps.timeslot > 0 && <span>{gaps.timeslot} with no timeslot</span>}
                    {gaps.mobile > 0 && <span>{gaps.mobile} with no mobile</span>}
                    {/* Worth calling out: these people finished but were never
                        on the imported start list, so the roster and the
                        standings disagree about who was racing. */}
                    {gaps.fromResults > 0 && (
                        <span className="text-warn">{gaps.fromResults} created from the results feed</span>
                    )}
                </div>
            )}

            {!athletes.length ? (
                <div className="mt-6">
                    <Empty
                        title="No athletes imported yet"
                        hint="Set the participant endpoint on Operations, then import the start list here."
                    />
                </div>
            ) : !rows.length ? (
                <div className="mt-6">
                    <Empty title="Nobody matches that search" />
                </div>
            ) : (
                <div className="mt-4 overflow-x-auto rounded-lg border border-smoke">
                    <table className="w-full min-w-[860px] text-sm">
                        <thead className="bg-coal text-xs uppercase tracking-wider text-fog">
                            <tr>
                                <th className="px-3 py-2 text-left">Bib</th>
                                <th className="px-3 py-2 text-left">Name</th>
                                <th className="px-3 py-2 text-left">Category</th>
                                <th className="px-3 py-2 text-left">Age group</th>
                                <th className="px-3 py-2 text-left">Club</th>
                                <th className="px-3 py-2 text-left">Gender</th>
                                <th className="px-3 py-2 text-left">Age / DOB</th>
                                <th className="px-3 py-2 text-left">Mobile</th>
                                <th className="px-3 py-2 text-left">Slot</th>
                                <th className="px-3 py-2 text-left">Events</th>
                                <th className="px-3 py-2 text-left">Source</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((a) => (
                                <tr key={a.id} className="border-t border-smoke">
                                    <td className="px-3 py-2 font-mono">{a.bib}</td>
                                    <td className="px-3 py-2 font-medium">{dash(a.name)}</td>
                                    <td className="px-3 py-2 text-fog">{dash(a.category)}</td>
                                    <td className="px-3 py-2 text-fog">{dash(a.age_group)}</td>
                                    <td className="px-3 py-2 text-fog">{dash(a.club)}</td>
                                    <td className="px-3 py-2 text-fog">{dash(a.gender)}</td>
                                    <td className="px-3 py-2 text-fog">
                                        {a.age !== null ? a.age : a.date_of_birth ? day(a.date_of_birth) : "—"}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-fog">{dash(a.mobile)}</td>
                                    <td className="px-3 py-2 text-fog">
                                        {dash(a.timeslot)}
                                        {a.contest_date ? ` · ${day(a.contest_date)}` : ""}
                                    </td>
                                    {/* The map, made visible: how many editions
                                        this person has entered in total. Anything
                                        above one means the phone + name identity
                                        matched them to an earlier event. */}
                                    <td className="px-3 py-2 text-fog">
                                        {a.events_entered > 1 ? (
                                            <span className="font-semibold text-chalk">{a.events_entered}</span>
                                        ) : (
                                            a.events_entered
                                        )}
                                    </td>
                                    <td className="px-3 py-2">
                                        {a.source === "results" ? <Chip tone="warn">Results</Chip> : <Chip>Start list</Chip>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
