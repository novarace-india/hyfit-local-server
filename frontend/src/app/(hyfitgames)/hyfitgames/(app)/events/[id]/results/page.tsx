"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, fmtMs, appPath } from "../../../../lib/api";
import { Spinner, Chip, Empty, ErrorNote } from "../../../../lib/ui";

/* MY results for one event.
 *
 * This page used to render the whole field, filtered by category — effectively
 * the leaderboard settled. It now shows only the logged-in athlete's own
 * entries, served by GET /me/events/:eventId/results.
 *
 * That changes the right shape for the page. `UNIQUE (event_id, athlete_id,
 * category)` means an athlete holds at most ONE entry per category, so a
 * category is no longer a list to be ranked and filtered — it is a single
 * result. One card per category, no filter strip, nothing collapsed behind a
 * tap: there are only ever a handful of cards.
 *
 * What survives the change, because it is the reason this page exists at all:
 * a doubles entry carries TWO results the athlete owns — the pair's placing and
 * each member's own leg — and both are shown. Leading with only the team time
 * hides what they personally ran; leading with only their leg invents a race
 * against their partner.
 *
 * A placing needs its field size to mean anything ("3rd of 24"), and that is the
 * one thing lost by not rendering the whole field — so the API counts it.
 */

type Member = {
    registration_id: string;
    bib: string;
    full_name: string;
    total_ms: number | null;
    category_rank: number | null;
    status: string;
    is_self: boolean;
};

type Row = {
    registration_id: string;
    bib: string;
    status: string;
    category: string;
    full_name: string;
    gender: string | null;
    city: string | null;
    total_ms: number | null;
    overall_rank: number | null;
    age_group: string | null;
    field_size: number | null;
    // The club, but only when it names a team (migration 065) — so it is also
    // the "this entry raced as a pair" flag.
    team_name: string | null;
    team_total_ms: number | null;
    team_rank: number | null;
    team_members: Member[] | null;
};

const isDoubles = (category: string) => /doubles/i.test(category);

function Placing({ rank, field, label }: { rank: number | null; field: number | null; label: string }) {
    return (
        <div>
            <p className="text-2xl font-black leading-none">
                {rank ? `#${rank}` : "—"}
                {rank && field ? <span className="text-base font-bold text-fog"> of {field}</span> : null}
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-wide text-fog">{label}</p>
        </div>
    );
}

function Clock({ ms, status, label }: { ms: number | null; status: string; label: string }) {
    return (
        <div className="text-right">
            <p className="text-2xl font-black leading-none">{ms ? fmtMs(ms) : status}</p>
            <p className="mt-1 text-[11px] uppercase tracking-wide text-fog">{label}</p>
        </div>
    );
}

export default function MyEventResults() {
    const { id } = useParams<{ id: string }>();
    const [data, setData] = useState<any>(null);
    const [event, setEvent] = useState<any>(null);
    const [err, setErr] = useState("");

    useEffect(() => {
        Promise.all([api(`/me/events/${id}/results`), api(`/events/${id}`)])
            .then(([r, e]) => {
                setData(r);
                setEvent(e);
            })
            .catch((e: any) => setErr(e.message));
    }, [id]);

    if (err) return <main className="px-5 pt-6"><ErrorNote msg={err} /></main>;
    if (!data || !event) return <Spinner />;

    const rows: Row[] = data.rows ?? [];

    return (
        <main className="px-5 pt-6">
            <Link href={appPath(`/hyfitgames/events/${id}`)} className="text-sm text-fog">
                ← Race hub
            </Link>
            <h1 className="mt-2 text-2xl font-black tracking-wide">{event.name?.toUpperCase()}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fog">
                <span>My results</span>
                {data.results_status === "final" ? (
                    <Chip tone="ok">Final</Chip>
                ) : data.results_status === "provisional" ? (
                    <Chip tone="warn">Provisional</Chip>
                ) : data.results_status === "live" ? (
                    /* Timing's own feed, mid-race, not yet published — so it can
                       still change, and saying "live" rather than letting it
                       look settled is the difference between a time an athlete
                       checks again and one they put on the internet. */
                    <Chip tone="live">Live</Chip>
                ) : null}
            </div>

            {data.results_status === "none" ? (
                <Empty
                    title="Results are not published yet"
                    hint="They appear here once the organiser publishes them."
                />
            ) : !rows.length ? (
                /* Published, but nothing of this athlete's in them — a different
                   thing from "not out yet", and saying so avoids the athlete
                   waiting for results that are already up. */
                <Empty
                    title="You have no results at this event"
                    hint="Only races you were entered in show up here."
                />
            ) : (
                <div className="mt-4 space-y-3">
                    {rows.map((r) => {
                        const team = Boolean(r.team_name);
                        // A doubles entry with no partner recorded is ranked
                        // among individuals, not teams — so its number is not
                        // comparable to the team placings in the same category.
                        const unpaired = !team && isDoubles(r.category);
                        const members = (r.team_members ?? []) as Member[];

                        return (
                            <section
                                key={r.registration_id}
                                className="rounded-xl border border-smoke bg-coal"
                            >
                                <header className="flex items-center gap-2 px-4 pt-3">
                                    <h2 className="min-w-0 flex-1 truncate text-xs font-bold uppercase tracking-[0.18em] text-fog">
                                        {r.category}
                                    </h2>
                                    {team && (
                                        <span className="shrink-0 rounded bg-smoke px-1.5 py-0.5 text-[10px] font-bold uppercase">
                                            Team
                                        </span>
                                    )}
                                </header>

                                {/* For a pair the headline IS the team's result;
                                    their own leg is below, with their partner's. */}
                                <div className="flex items-end justify-between px-4 pb-3 pt-2">
                                    <Placing
                                        rank={team ? r.team_rank : r.overall_rank}
                                        field={r.field_size}
                                        label={team ? "team placing" : unpaired ? "individual" : "placing"}
                                    />
                                    <Clock
                                        ms={team ? r.team_total_ms : r.total_ms}
                                        status={r.status}
                                        label={team ? "team time" : "time"}
                                    />
                                </div>

                                {unpaired && (
                                    <p className="border-t border-smoke/60 px-4 py-2 text-[11px] text-warn">
                                        No partner recorded — placed among individuals, not teams
                                    </p>
                                )}

                                {team && members.length > 0 && (
                                    <ul className="border-t border-smoke/60 px-4 py-1">
                                        {members.map((m) => (
                                            <li key={m.registration_id}>
                                                <Link
                                                    href={appPath(
                                                        `/hyfitgames/events/${id}/scorecard/${m.registration_id}`,
                                                    )}
                                                    className="flex items-center gap-3 py-1.5 text-sm hover:text-hyred-ink"
                                                >
                                                    <span className="w-10 shrink-0 font-mono text-xs text-fog">
                                                        {m.bib}
                                                    </span>
                                                    <span className="min-w-0 flex-1 truncate">
                                                        {m.full_name}
                                                        {m.is_self && (
                                                            <span className="ml-1.5 text-[11px] text-fog">(you)</span>
                                                        )}
                                                    </span>
                                                    <span className="shrink-0 font-black">
                                                        {m.total_ms ? fmtMs(m.total_ms) : m.status}
                                                    </span>
                                                    <span className="w-10 shrink-0 text-right text-xs text-fog">
                                                        {m.category_rank ? `#${m.category_rank}` : "—"}
                                                    </span>
                                                    <span className="shrink-0 text-fog">→</span>
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                <div className="border-t border-smoke/60 px-4 py-2 text-xs text-fog">
                                    <span>
                                        Bib {r.bib}
                                        {r.age_group ? ` · ${r.age_group}` : ""}
                                    </span>
                                    {!team && (
                                        <Link
                                            href={appPath(
                                                `/hyfitgames/events/${id}/scorecard/${r.registration_id}`,
                                            )}
                                            className="ml-3 font-bold text-hyred-ink"
                                        >
                                            View scorecard →
                                        </Link>
                                    )}
                                </div>
                            </section>
                        );
                    })}

                    {/* The full field is still a tap away — this page answering
                        "how did I do" does not mean the athlete stops wanting
                        "how did that compare". */}
                    <Link
                        href={appPath(`/hyfitgames/events/${id}/leaderboard`)}
                        className="block rounded-xl border border-smoke px-4 py-3 text-center text-sm font-bold text-fog hover:text-chalk"
                    >
                        See the full field →
                    </Link>
                </div>
            )}
        </main>
    );
}
