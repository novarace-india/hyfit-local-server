"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, fmtMs, fmtDate, appPath } from "../lib/api";
import { Spinner, Chip, statusChip, Empty, SectionTitle, ErrorNote } from "../lib/ui";

// Athlete home / dashboard. Ported from pages/Dashboard.jsx.
export default function Dashboard() {
    const [me, setMe] = useState<any>(null);
    const [events, setEvents] = useState<any>(null);
    const [stats, setStats] = useState<any>(null);
    const [err, setErr] = useState("");

    useEffect(() => {
        Promise.all([api("/me"), api("/me/events"), api("/me/stats")])
            .then(([m, e, s]) => {
                setMe(m);
                setEvents(e);
                setStats(s);
            })
            .catch((e) => setErr(e.message));
    }, []);

    if (err) return <main className="p-5"><ErrorNote msg={err} /></main>;
    if (!me || !events || !stats) return <Spinner />;

    const firstName = me.full_name.split(" ")[0];
    const next = events.upcoming[0];

    // /me/events returns one row per entry, and an athlete can enter several
    // categories at one event — one here holds three bibs at Coimbatore. The
    // card is per event, so it needs all of that event's entries, not just the
    // first row: showing one silently hid the other two categories.
    const nextEntries = next
        ? events.upcoming.filter((e: any) => e.event_id === next.event_id)
        : [];

    return (
        <main className="px-5 pt-6">
            <p className="text-sm text-fog">Welcome back</p>
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-black tracking-wide">{firstName.toUpperCase()}</h1>
                <Link href={appPath("/hyfitgames/my-stats")} className="text-xs font-bold text-hyred-ink">
                    My Stats →
                </Link>
            </div>

            {!me.profile_complete && (
                <Link
                    href={appPath("/hyfitgames/profile")}
                    className="mt-4 block rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn"
                >
                    Complete your profile — DOB, city and emergency contact are needed for race day. →
                </Link>
            )}

            <SectionTitle>{next?.status === "live" ? "Happening now" : "Your next race"}</SectionTitle>
            {next ? (
                <Link
                    href={appPath(`/hyfitgames/events/${next.event_id}`)}
                    className="block rounded-2xl border border-smoke bg-gradient-to-br from-coal to-ink p-5"
                >
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <h2 className="text-xl font-black tracking-wide">{next.name.toUpperCase()}</h2>
                            <p className="mt-1 text-sm text-fog">
                                {fmtDate(next.event_date)} · {next.city}
                            </p>
                        </div>
                        {next.status === "live" ? <Chip tone="live">Live</Chip> : <Chip>Upcoming</Chip>}
                    </div>
                    {/* One entry: the bib and wave are the useful numbers, with
                        the category naming what they are for. Several: each is
                        its own bib in its own contest, so they are listed
                        rather than collapsed into whichever came first. */}
                    {nextEntries.length > 1 ? (
                        <div className="mt-4 space-y-1.5">
                            <p className="text-sm text-fog">
                                You are entered in {nextEntries.length} categories
                            </p>
                            {nextEntries.map((entry: any) => (
                                <div
                                    key={entry.registration_id}
                                    className="flex items-baseline gap-2 text-sm"
                                >
                                    <span className="text-lg font-black text-hyred-ink">{entry.bib}</span>
                                    <span className="font-semibold">{entry.category}</span>
                                    {entry.wave && <span className="text-fog">· {entry.wave}</span>}
                                </div>
                            ))}
                            <div className="pt-1 text-sm text-hyred-ink">Open race hub →</div>
                        </div>
                    ) : (
                        <div className="mt-4 flex gap-6 text-sm">
                            <div>
                                <p className="text-fog">Bib</p>
                                <p className="text-2xl font-black text-hyred-ink">{next.bib}</p>
                            </div>
                            {next.wave && (
                                <div>
                                    <p className="text-fog">Wave</p>
                                    <p className="text-2xl font-black">{next.wave}</p>
                                </div>
                            )}
                            {next.category && (
                                <div className="min-w-0">
                                    <p className="text-fog">Category</p>
                                    <p className="truncate text-base font-black">{next.category}</p>
                                </div>
                            )}
                            <div className="ml-auto self-end text-hyred-ink">Open race hub →</div>
                        </div>
                    )}
                </Link>
            ) : (
                <Empty
                    title="No upcoming race yet"
                    hint="When you register for the next HYFIT Games edition, it will appear here."
                />
            )}

            <SectionTitle>Your numbers</SectionTitle>
            <div className="grid grid-cols-3 gap-3">
                {[
                    [stats.editions, "Editions"],
                    [stats.finishes, "Finishes"],
                    [stats.pb_ms ? fmtMs(stats.pb_ms) : "—", "Personal best"],
                ].map(([v, l]) => (
                    <div key={l as string} className="rounded-xl bg-coal p-3 text-center">
                        <p className="text-2xl font-black text-chalk">{v}</p>
                        <p className="mt-0.5 text-[11px] uppercase tracking-wide text-fog">{l}</p>
                    </div>
                ))}
            </div>

            <SectionTitle>Past races</SectionTitle>
            {events.past.length === 0 && <Empty title="Your race history starts with your first finish" />}
            <div className="space-y-3">
                {events.past.map((e: any) => (
                    <Link
                        key={e.registration_id}
                        // The event hub, not the bare result: it is the page that
                        // holds the leaderboard, the result and the race details
                        // together, so it is the right landing point from a race
                        // in your history.
                        //
                        // `reg` carries which entry was tapped. An athlete can hold
                        // several bibs at one event — one per category, and one here
                        // has three at Coimbatore — so all three rows point at the
                        // same event page. Without this it would always resolve to
                        // whichever registration happened to come first, and the
                        // other two results would be unreachable from home.
                        href={appPath(`/hyfitgames/events/${e.event_id}?reg=${e.registration_id}`)}
                        className="flex items-center justify-between rounded-xl border border-smoke bg-coal px-4 py-3"
                    >
                        <div className="min-w-0">
                            <p className="truncate font-semibold">{e.name}</p>
                            {/* The category is what tells these rows apart when
                                someone entered the same event several times —
                                three Coimbatore rows differing only by bib is
                                not something anyone can read. */}
                            <p className="truncate text-xs text-fog">
                                {fmtDate(e.event_date)} · Bib {e.bib}
                                {e.category ? ` · ${e.category}` : ""}
                            </p>
                        </div>
                        <div className="text-right">
                            {/* A pair's result is the team's time, not their own leg. */}
                            <p className="text-lg font-black">{fmtMs(e.team_total_ms ?? e.total_ms)}</p>
                            <div className="mt-0.5">{statusChip(e.reg_status)}</div>
                        </div>
                    </Link>
                ))}
            </div>
        </main>
    );
}
