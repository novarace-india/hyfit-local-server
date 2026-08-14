"use client";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, fmtMs, appPath } from "../../../../lib/api";
import { Spinner, Chip, ErrorNote } from "../../../../lib/ui";

const AGE_GROUPS = ["", "U18", "18-29", "30-39", "40-49", "50-59", "60+"];
const POLL_MS = 15000;

// Live leaderboard with spacious, custom-styled dropdown filters.
export default function Leaderboard() {
    const { id } = useParams<{ id: string }>();
    const [ev, setEv] = useState<any>(null);
    const [board, setBoard] = useState<any>(null);
    const [category, setCategory] = useState("");
    const [gender, setGender] = useState("");
    const [ageGroup, setAgeGroup] = useState("");
    const [search, setSearch] = useState("");
    const [err, setErr] = useState("");
    const timer = useRef<ReturnType<typeof setInterval> | null>(null);

    const load = useCallback(async () => {
        try {
            const qs = new URLSearchParams();
            if (category) qs.set("category", category);
            if (gender) qs.set("gender", gender);
            if (ageGroup) qs.set("age_group", ageGroup);
            if (search) qs.set("search", search);
            setBoard(await api(`/events/${id}/leaderboard?${qs}`));
            setErr("");
        } catch (e: any) {
            setErr(e.message);
        }
    }, [id, category, gender, ageGroup, search]);

    useEffect(() => {
        api(`/events/${id}`).then(setEv).catch((e) => setErr(e.message));
    }, [id]);

    useEffect(() => {
        load();
        if (ev?.status === "live") {
            timer.current = setInterval(load, POLL_MS);
            return () => {
                if (timer.current) clearInterval(timer.current);
            };
        }
    }, [load, ev?.status]);

    // Extract categories returned by API or from event rows
    const categories = useMemo(() => {
        if (board?.categories && Array.isArray(board.categories) && board.categories.length > 0) {
            return board.categories;
        }
        if (board?.rows && Array.isArray(board.rows)) {
            const set = new Set<string>();
            board.rows.forEach((r: any) => {
                if (r.category) set.add(r.category);
            });
            return Array.from(set).sort();
        }
        return [];
    }, [board]);

    /* "Official" here means "these rows carry finish times and placings", not
     * "these results are final" — it is what switches the board from the
     * in-progress view (running total, stations done) to the ranked one.
     *
     * A live RaceResult feed is unpublished, so the EVENT still says 'none',
     * but its rows are ranked finish times with no splits behind them. The
     * board reports that itself, and it is the only thing that can: the event
     * cannot, by design. Without this the feed renders as "undefined/6
     * stations" against a blank time.
     */
    const liveBoard = board?.results_status === "live";
    const official = ev?.results_status !== "none" || liveBoard;

    return (
        <main className="px-5 pt-6 pb-12">
            <Link href={appPath(`/hyfitgames/events/${id}`)} className="text-sm text-fog hover:text-chalk transition-colors">
                ← Race hub
            </Link>
            <div className="mt-2 flex items-center justify-between">
                <h1 className="text-2xl font-black tracking-wide uppercase">Leaderboard</h1>
                {liveBoard ? (
                    <Chip tone="live">Live timing · updates every {POLL_MS / 1000}s</Chip>
                ) : ev?.status === "live" ? (
                    <Chip tone="live">Live · updates every {POLL_MS / 1000}s</Chip>
                ) : ev?.results_status === "provisional" ? (
                    <Chip tone="warn">Provisional</Chip>
                ) : ev?.results_status === "final" ? (
                    <Chip tone="ok">Final</Chip>
                ) : null}
            </div>

            {/* Sticky Dropdown Filter Bar */}
            <div className="sticky top-0 z-20 -mx-5 mt-3 space-y-3 bg-ink/95 backdrop-blur-md px-5 py-3 border-b border-smoke/60 shadow-xl">
                {/* Search Bar */}
                <div className="relative">
                    <input
                        className="w-full rounded-xl border border-smoke/80 bg-coal px-4 py-2.5 pl-10 text-sm outline-none transition-all focus:border-hyred focus:ring-1 focus:ring-hyred/50 placeholder:text-fog/70"
                        placeholder="Search athlete by name or bib…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    <svg className="absolute left-3.5 top-3 h-4 w-4 text-fog" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    {search && (
                        <button onClick={() => setSearch("")} className="absolute right-3 top-2.5 text-xs text-fog hover:text-chalk">
                            Clear
                        </button>
                    )}
                </div>

                {/* Dropdown Filters Grid */}
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
                    {/* Category / Contest Dropdown */}
                    <div className="sm:col-span-6">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-fog">Contest / Category</label>
                        <div className="relative">
                            <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                className="w-full appearance-none rounded-xl border border-smoke/80 bg-coal py-2.5 pl-3.5 pr-9 text-xs font-semibold text-chalk outline-none transition-all focus:border-hyred focus:ring-1 focus:ring-hyred/50 truncate cursor-pointer"
                            >
                                <option value="">All Contests</option>
                                {categories.map((c: string) => (
                                    <option key={c} value={c}>
                                        {c}
                                    </option>
                                ))}
                            </select>
                            <svg className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-fog" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </div>
                    </div>

                    {/* Gender Dropdown */}
                    <div className="sm:col-span-3">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-fog">Gender</label>
                        <div className="relative">
                            <select
                                value={gender}
                                onChange={(e) => setGender(e.target.value)}
                                className="w-full appearance-none rounded-xl border border-smoke/80 bg-coal py-2.5 pl-3.5 pr-9 text-xs font-semibold text-chalk outline-none transition-all focus:border-hyred focus:ring-1 focus:ring-hyred/50 truncate cursor-pointer"
                            >
                                <option value="">All Genders</option>
                                <option value="male">Men</option>
                                <option value="female">Women</option>
                            </select>
                            <svg className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-fog" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </div>
                    </div>

                    {/* Age Group Dropdown */}
                    <div className="sm:col-span-3">
                        <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-fog">Age Group</label>
                        <div className="relative">
                            <select
                                value={ageGroup}
                                onChange={(e) => setAgeGroup(e.target.value)}
                                className="w-full appearance-none rounded-xl border border-smoke/80 bg-coal py-2.5 pl-3.5 pr-9 text-xs font-semibold text-chalk outline-none transition-all focus:border-hyred focus:ring-1 focus:ring-hyred/50 truncate cursor-pointer"
                            >
                                {AGE_GROUPS.map((a) => (
                                    <option key={a} value={a}>
                                        {a ? `Age ${a}` : "All Ages"}
                                    </option>
                                ))}
                            </select>
                            <svg className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-fog" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </div>
                    </div>
                </div>
            </div>

            <ErrorNote msg={err} />
            {!board ? (
                <Spinner />
            ) : (
                <>
                {/* Says which pool the numbers on the left are placings in.
                    Without it "#1" next to a Male Doubles row reads as first in
                    the event, which is what it used to mean and no longer does. */}
                {official && (
                    <p className="mt-3 text-[11px] text-fog">
                        Placings are within each contest{category ? "" : " — pick one above to see a single ranking"}.
                        Doubles are ranked as teams on their later partner's finish.
                    </p>
                )}
                <ol className="mt-4 space-y-2.5">
                    {board.rows.map((r: any, i: number) => (
                        <Link
                            key={r.registration_id}
                            href={appPath(`/hyfitgames/events/${id}/scorecard/${r.registration_id}`)}
                            className="group flex items-center gap-3.5 rounded-xl border border-smoke/70 bg-coal p-3.5 transition-all hover:border-hyred/40 hover:bg-coal/90 active:scale-[0.99]"
                        >
                            {/* A pair's placing is its team rank; a solo's is its
                                placing inside its own contest. Neither is an
                                event-wide number, which is why the caption below
                                names the pool. */}
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink text-lg font-black text-hyred-ink border border-smoke/40">
                                {official && (r.team_rank ?? r.overall_rank)
                                    ? (r.team_rank ?? r.overall_rank)
                                    : i + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="truncate font-bold text-chalk group-hover:text-hyred-ink transition-colors">
                                        {r.full_name}
                                    </p>
                                    {r.category && (
                                        <span className="shrink-0 rounded-md bg-hyred/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-hyred-ink border border-hyred/30">
                                            {r.category}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-0.5 text-xs text-fog">
                                    Bib {r.bib} · {r.gender ? (r.gender === "male" ? "M" : "F") : ""}
                                    {r.city ? ` · ${r.city}` : ""}
                                    {r.age_group ? ` · Age ${r.age_group}` : ""}
                                </p>
                                {r.team_name && (
                                    /* The team's row carries one time, so each
                                       member's own leg goes here — otherwise the
                                       pair looks like a single result and the
                                       second athlete is invisible. */
                                    <p className="mt-0.5 truncate text-xs text-warn">
                                        {(r.team_members ?? []).length
                                            ? r.team_members
                                                  .map(
                                                      (m: any) =>
                                                          `${m.full_name} ${m.total_ms ? fmtMs(m.total_ms) : m.status}`,
                                                  )
                                                  .join("  ·  ")
                                            : "partner not recorded"}
                                    </p>
                                )}
                            </div>
                            <div className="text-right">
                                <p className="text-lg font-black tracking-tight text-chalk">
                                    {fmtMs(official ? (r.team_total_ms ?? r.total_ms ?? r.cum_ms) : r.cum_ms)}
                                </p>
                                <p className="text-[11px] font-semibold text-fog">
                                    {r.status === "DNF" ? (
                                        <span className="text-warn">DNF</span>
                                    ) : r.stations_done == null ? (
                                        /* A live feed carries finish times, not
                                           splits, so there is no station count
                                           to report — only whether this athlete
                                           is done. */
                                        r.total_ms ? (
                                            "finished"
                                        ) : (
                                            "on course"
                                        )
                                    ) : (
                                        `${r.stations_done}/6 stations`
                                    )}
                                </p>
                            </div>
                        </Link>
                    ))}
                    {board.rows.length === 0 && (
                        <div className="rounded-2xl border border-dashed border-smoke/80 bg-coal/50 py-12 text-center">
                            <p className="text-base font-bold text-chalk">No athletes match this filter</p>
                            <p className="mt-1 text-xs text-fog">Try clearing your filters to view overall results.</p>
                            {(category || gender || ageGroup || search) && (
                                <button
                                    onClick={() => {
                                        setCategory("");
                                        setGender("");
                                        setAgeGroup("");
                                        setSearch("");
                                    }}
                                    className="mt-4 rounded-xl bg-hyred px-4 py-2 text-xs font-bold uppercase tracking-wider text-onfill hover:bg-hyred/90 transition-colors"
                                >
                                    Reset Filters
                                </button>
                            )}
                        </div>
                    )}
                </ol>
                </>
            )}
        </main>
    );
}
