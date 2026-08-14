"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, fmtDate, appPath } from "../../../lib/api";
import { Spinner, Chip, SectionTitle, ErrorNote, Empty } from "../../../lib/ui";

// Race hub for a single event. Ported from pages/EventHub.jsx.
export default function EventHub() {
    const { id } = useParams<{ id: string }>();
    const [ev, setEv] = useState<any>(null);
    const [mine, setMine] = useState<any>(null);
    const [err, setErr] = useState("");

    useEffect(() => {
        // `?reg=` names which entry the athlete came in on. It matters because
        // one person can hold several bibs at one event, one per category, and
        // `find` would otherwise always settle on the first — showing the wrong
        // bib and linking to the wrong result for the other entries.
        //
        // Read off location rather than useSearchParams: this is already inside
        // an effect, so there is no hydration concern, and it avoids dragging a
        // Suspense boundary requirement into a page that needs nothing else
        // from the router.
        const wanted = new URLSearchParams(window.location.search).get("reg");
        Promise.all([api(`/events/${id}`), api("/me/events")])
            .then(([e, m]: any) => {
                setEv(e);
                const entries = [...m.upcoming, ...m.past].filter((x: any) => x.event_id === id);
                setMine(entries.find((x: any) => x.registration_id === wanted) || entries[0] || null);
            })
            .catch((e) => setErr(e.message));
    }, [id]);

    if (err) return <main className="p-5"><ErrorNote msg={err} /></main>;
    if (!ev) return <Spinner />;

    return (
        <main className="px-5 pt-6">
            <Link href={appPath("/hyfitgames")} className="text-sm text-fog">
                ← Home
            </Link>
            <div className="mt-2 flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-black tracking-wide">{ev.name.toUpperCase()}</h1>
                    <p className="mt-1 text-sm text-fog">
                        {fmtDate(ev.event_date)} · {ev.venue || ev.city}
                    </p>
                </div>
                {ev.status === "live" && <Chip tone="live">Live</Chip>}
                {ev.results_status === "provisional" && <Chip tone="warn">Provisional</Chip>}
                {ev.results_status === "final" && <Chip tone="ok">Final</Chip>}
            </div>

            {mine && (
                <div className="mt-5 rounded-2xl border border-hyred/40 bg-coal p-4">
                    <p className="text-xs uppercase tracking-wide text-fog">Your race</p>
                    <div className="mt-2 flex gap-6">
                        <div>
                            <p className="text-fog text-xs">Bib</p>
                            <p className="text-3xl font-black text-hyred-ink">{mine.bib}</p>
                        </div>
                        {mine.wave && (
                            <div>
                                <p className="text-fog text-xs">Wave</p>
                                <p className="text-3xl font-black">{mine.wave}</p>
                            </div>
                        )}
                        {mine.start_time && (
                            <div>
                                <p className="text-fog text-xs">Start</p>
                                <p className="text-3xl font-black">
                                    {new Date(mine.start_time).toLocaleTimeString("en-IN", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                    })}
                                </p>
                            </div>
                        )}
                    </div>
                    <Link
                        href={appPath(`/hyfitgames/results/${mine.registration_id}`)}
                        className="mt-3 inline-block text-sm font-semibold text-hyred-ink"
                    >
                        My splits & result →
                    </Link>
                </div>
            )}

            <div className="mt-5 grid grid-cols-2 gap-3">
                <Link
                    href={appPath(`/hyfitgames/events/${id}/leaderboard`)}
                    className="rounded-xl bg-hyred px-4 py-4 text-center font-bold uppercase tracking-wide text-onfill"
                >
                    {ev.status === "live" ? "Live leaderboard" : "Leaderboard"}
                </Link>
                {/* This athlete's own results across every category they
                    entered — including a doubles pair's placing, which the
                    per-registration link above cannot show because it is scoped
                    to one entry. The whole field is the Leaderboard beside it,
                    and from inside the page. */}
                <Link
                    href={appPath(`/hyfitgames/events/${id}/results`)}
                    className="rounded-xl border border-smoke bg-coal px-4 py-4 text-center font-bold uppercase tracking-wide"
                >
                    My results
                </Link>
            </div>

            <SectionTitle>The course</SectionTitle>
            <ol className="space-y-2">
                {ev.stations.map((s: any) => (
                    <li key={s.id} className="flex items-center gap-3 rounded-lg bg-coal px-3 py-2 text-sm">
                        <span className="text-hyred-ink">{s.seq}</span>
                        <span className="text-fog">200m run →</span> {s.name}
                    </li>
                ))}
            </ol>

            <SectionTitle>Announcements</SectionTitle>
            {ev.announcements.length === 0 && (
                <Empty title="Nothing yet" hint="Race-day updates from the organiser will appear here." />
            )}
            <div className="space-y-3">
                {ev.announcements.map((a: any) => (
                    <div key={a.id} className="rounded-xl border border-smoke bg-coal p-4">
                        <p className="font-semibold">{a.title}</p>
                        <p className="mt-1 text-sm text-fog">{a.body}</p>
                    </div>
                ))}
            </div>
        </main>
    );
}
