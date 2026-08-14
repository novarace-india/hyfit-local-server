"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { judgeApi, appPath } from "../../../lib/api";
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
    event_date: string | null;
    timezone: string;
    platformEventId: string | null;
};

const STATUSES = ["draft", "ready", "live", "closed", "archived"];

function when(row: EventRow) {
    if (row.starts_at)
        return `${new Date(row.starts_at).toLocaleString()} · ${row.timezone}`;
    if (row.event_date) return new Date(row.event_date).toLocaleDateString();
    return "No schedule set";
}

export default function AdminEvents() {
    const { user: fieldUser, ready: fieldReady } = useFieldSession();
    const [rows, setRows] = useState<EventRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [filter, setFilter] = useState("all");
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");

    const load = useCallback(async () => {
        setErr("");
        try {
            const data = await judgeApi<{ events: EventRow[] }>("/admin/events");
            setRows(data.events ?? []);
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
                    {showCreate ? "Cancel" : "+ New Event"}
                </button>
            </div>

            {showCreate && (
                <CreateEvent
                    onDone={() => {
                        setShowCreate(false);
                        void load();
                    }}
                />
            )}

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
                        {s} {s !== "all" && `(${countFor(s)})`}
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
                                        <span className="font-bold">{row.name}</span>
                                        {row.is_active && <Chip tone="live">Active</Chip>}
                                        <Chip tone={row.status === "live" ? "live" : row.status === "closed" ? "ok" : "default"}>
                                            {row.status}
                                        </Chip>
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
                                    <button
                                        disabled={row.is_active}
                                        onClick={() =>
                                            void patch(row, { activate: true }, `${row.name} is now the active event`)
                                        }
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                                    >
                                        {row.is_active ? "Active" : "Make active"}
                                    </button>
                                    <Link
                                        href={appPath(`/hyfitgames/admin/events/${row.id}/operations`)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                    >
                                        Operations
                                    </Link>
                                    <Link
                                        href={appPath(`/hyfitgames/admin/events/${row.id}/team`)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                                    >
                                        Team
                                    </Link>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function CreateEvent({ onDone }: { onDone: () => void }) {
    const [form, setForm] = useState({
        name: "",
        venue: "",
        eventDate: "",
        startsAt: "",
        timezone: "Asia/Kolkata",
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
                    startsAt: form.startsAt || null,
                    timezone: form.timezone,
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
                {/* The day the event runs. The check-in window anchors an
                    athlete's timeslot to it for anyone whose RaceResult
                    ContestDate is blank — on a single-day event, everyone. */}
                {input("eventDate", "Event Date", "date")}
                {input("startsAt", "Starts At", "datetime-local")}
                {input("timezone", "Timezone", "text", { placeholder: "Asia/Kolkata" })}
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
