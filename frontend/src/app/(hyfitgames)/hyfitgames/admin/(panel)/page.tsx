"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { judgeApi, fmtEventDays, appPath } from "../../lib/api";
import { Spinner, Chip } from "../../lib/ui";
import { useFieldSession } from "../../lib/field-session";

type Overview = {
    name: string;
    venue: string;
    status: string;
    // Null until endpoints are published for the event.
    configVersion: number | null;
    // Both counted off the RaceResult start list. Null means the feed could not
    // be read — not that nobody is entered.
    participants: number | null;
    checkedIn: number | null;
    onCourse: number;
    activeJudges: number;
    pendingSync: number;
    conflicts: number;
};

// The console dashboard: the whole-programme view across the top, and — when
// the operator holds a field credential — the live state of the active event
// underneath it. That second half is what the separate judge control centre
// used to open on; there is no reason to sign in to another app to see it.
export default function AdminDashboard() {
    const { user: fieldUser } = useFieldSession();
    const [data, setData] = useState<any>(null);
    const [events, setEvents] = useState<any[]>([]);
    const [overview, setOverview] = useState<Overview | null>(null);

    // Counted off the operational events, in hyfit_v2. This read the athlete
    // platform's listings until that schema went; the statuses below are the
    // operational lifecycle, not a publication one, which is the only lifecycle
    // this console has any say over.
    useEffect(() => {
        if (!fieldUser) {
            setData({ total: 0, live: 0, ready: 0, closed: 0 });
            return;
        }
        judgeApi<{ events: any[] }>("/admin/events")
            .then((d) => {
                const evts = d.events ?? [];
                setEvents(evts);
                setData({
                    total: evts.length,
                    live: evts.filter((e) => e.status === "live").length,
                    ready: evts.filter((e) => e.status === "ready").length,
                    closed: evts.filter((e) => e.status === "closed").length,
                });
            })
            .catch(() => setData({ total: 0, live: 0, ready: 0, closed: 0 }));
    }, [fieldUser]);

    useEffect(() => {
        if (!fieldUser) {
            setOverview(null);
            return;
        }
        judgeApi<{ overview: Overview | null }>("/admin/overview")
            .then((d) => setOverview(d.overview))
            .catch(() => setOverview(null));
    }, [fieldUser]);

    if (!data) return <Spinner />;

    const stat = (label: string, value: any, tone?: any) => (
        <div className="rounded-xl border border-smoke bg-coal p-4">
            <p className="text-2xl font-black tracking-tight">{value}</p>
            <p className="mt-1 text-xs font-bold uppercase tracking-wider text-fog">{label}</p>
            {tone && (
                <div className="mt-2">
                    <Chip tone={tone}>{tone}</Chip>
                </div>
            )}
        </div>
    );

    return (
        <div>
            <h1 className="text-2xl font-black uppercase tracking-wide">Dashboard</h1>
            <p className="mt-1 text-sm text-fog">Field operations across every event</p>

            {/* The operational lifecycle. There is no registration total here
                any more: entries belong to the athlete platform, and the roster
                the counters and tablets work against is RaceResult's — counted
                on the live strip below, from the feed itself. */}
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {stat("Total Events", data.total)}
                {stat("Live", data.live, data.live > 0 ? "live" : undefined)}
                {stat("Ready", data.ready)}
                {/* 'closed' in the column, "Completed" on every screen — the
                    same wording as the Events list. See STATUS_LABEL there. */}
                {stat("Completed", data.closed, "ok")}
            </div>

            {overview && (
                <>
                    <div className="mb-3 mt-8 flex items-baseline justify-between">
                        <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-fog">
                            Live operations · {overview.name}
                        </h2>
                        <span className="text-xs text-fog">
                            {/* No published version is a real and common state —
                                an event mid-setup — and reads better as "no
                                endpoints published" than as "config v". */}
                            {overview.venue || "No venue"} ·{" "}
                            {overview.configVersion ? `config v${overview.configVersion}` : "no endpoints published"} ·{" "}
                            {overview.status}
                        </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                        {/* Both read off the RaceResult start list, which is the
                            roster the counters and tablets actually work
                            against. Null means the feed could not be read — not
                            that nobody is entered, and not that nobody has
                            arrived. */}
                        {stat("Roster", overview.participants ?? "—")}
                        {stat("Checked in", overview.checkedIn ?? "—")}
                        {stat("On course", overview.onCourse)}
                        {stat("Active judges", overview.activeJudges)}
                        {stat("Pending sync", overview.pendingSync, overview.pendingSync ? "warn" : undefined)}
                        {stat("Conflicts", overview.conflicts, overview.conflicts ? "warn" : undefined)}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {[
                            ["Team", "/hyfitgames/admin/team"],
                            ["Operations", "/hyfitgames/admin/operations"],
                        ].map(([label, to]) => (
                            <Link
                                key={to}
                                href={appPath(to)}
                                className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                            >
                                {label} →
                            </Link>
                        ))}
                        <Link
                            href="/hyfitgames/checkin"
                            className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                        >
                            Check-in app →
                        </Link>
                        <Link
                            href="/hyfitgames/judge"
                            className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk"
                        >
                            Judge app →
                        </Link>
                    </div>
                </>
            )}

            <h2 className="mb-3 mt-8 text-xs font-bold uppercase tracking-[0.18em] text-fog">Events</h2>
            <div className="space-y-2">
                {events.slice(0, 10).map((e) => (
                    <Link
                        key={e.id}
                        href={appPath(`/hyfitgames/admin/events/${e.id}/operations`)}
                        className="flex items-center justify-between rounded-xl border border-smoke bg-coal p-3 hover:border-hyred/40"
                    >
                        <div>
                            <p className="font-semibold">{e.name}</p>
                            <p className="text-xs text-fog">
                                {/* The span, not Day 1. A two-day edition
                                    named only by its first day reads here as an
                                    event that finished that evening. */}
                                {fmtEventDays(e.event_date, e.event_end_date, { empty: "No date set" })} ·{" "}
                                {e.venue || "Venue TBD"}
                            </p>
                        </div>
                        <Chip tone={e.status === "live" ? "live" : e.status === "closed" ? "ok" : "default"}>
                            {e.status === "closed" ? "completed" : e.status}
                        </Chip>
                    </Link>
                ))}
            </div>
        </div>
    );
}
