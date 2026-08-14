"use client";

/* Results for one event: yours, or everybody's.
 *
 * TWO READS, DELIBERATELY SEPARATE.
 *
 *   Your result  GET /api/hyfitgames/me/events/:id/results — authenticated,
 *                filtered server-side to the bibs on your own entries, and a
 *                few hundred bytes.
 *   Leaderboard  GET /api/hyfit-judge/public/events/:id/results — the whole
 *                field, unauthenticated, and a thousand rows on a big event.
 *
 * A signed-in athlete lands on their own result and the leaderboard is only
 * fetched when they ask for it. That is the point of the split: somebody
 * checking their time on venue wifi should not be made to download a thousand
 * strangers first, and the public board must keep working for the family at
 * home with no login at all.
 *
 * Both come from the same service and the same cache key on the server, so an
 * athlete's own row and the row with their name on it in the leaderboard are
 * the same object. They cannot disagree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, appPath, fmtMs, session } from "../../lib/api";
import { Spinner, Empty, Chip } from "../../lib/ui";
import SplitTimeline from "../../lib/split-timeline";
import BottomNav from "../../lib/BottomNav";
import HfgThemeToggle from "../../lib/theme-toggle";

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

type Board = {
    event_id: string;
    event_name: string;
    source: "live" | "stored";
    fetched_at: string;
    rows: Row[];
};

type Mine = {
    results_status: "none" | "live" | "final";
    updated_at?: string;
    event_name?: string;
    /** One per entry: an athlete holding three bibs at one event ran three
     *  races, and showing the first would hide two of them. */
    mine: {
        entry_id: string;
        bib: string;
        category: string | null;
        club: string | null;
        row: Row | null;
    }[];
    /** Contest name → how many started it. A bare "3rd" means nothing without
     *  it, and it is what you lose by not being shown the whole field. */
    field: Record<string, number>;
};

// Live standings move while somebody is looking at them. Thirty seconds is
// slower than the organiser can publish and far slower than the race changes.
const REFRESH_MS = 30_000;

/* What makes a row itself.
 *
 * NOT the bib: one athlete can race two contests under one number, and those
 * are two rows with two times. Keying React on the bib alone gave them the same
 * key, so the list rendered one of them and the expander opened both at once.
 * Mirrors `entryKey` on the server, which is what the two are joined by there. */
const rowKey = (row: { bib: string; category: string | null }) =>
    `${row.bib}|${(row.category ?? "").toLowerCase()}`;

export default function EventResultsPage() {
    const { eventId } = useParams<{ eventId: string }>();
    const router = useRouter();
    const [view, setView] = useState<"mine" | "board">("board");
    const [mine, setMine] = useState<Mine | null>(null);
    const [board, setBoard] = useState<Board | null>(null);
    const [eventName, setEventName] = useState("");
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState("");
    const [category, setCategory] = useState("all");
    const [open, setOpen] = useState<string | null>(null);

    // Read once, on mount: whether there is an athlete session at all decides
    // which of the two reads this page is even allowed to make.
    const [signedIn] = useState(() => session.isLoggedIn());
    // Only the FIRST load may blank the screen or report an error. A refresh
    // that fails — a tunnel, venue wifi — must not throw away standings
    // somebody is reading, or collapse a row they have open.
    const first = useRef(true);

    const loadMine = useCallback(async () => {
        if (!signedIn) return null;
        const data = await api<Mine>(`/me/events/${eventId}/results`);
        setMine(data);
        return data;
    }, [eventId, signedIn]);

    const loadBoard = useCallback(async () => {
        const res = await fetch(`/api/hyfit-judge/public/events/${eventId}/results`, {
            cache: "no-store",
        });
        if (res.status === 404) {
            setBoard(null);
            return null;
        }
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error ?? `Results unavailable (HTTP ${res.status})`);
        }
        const data: Board = await res.json();
        setBoard(data);
        return data;
    }, [eventId]);

    // First load: find out whether this athlete is in this event before
    // choosing a view. Somebody who raced it opens on their own result;
    // everybody else — a spectator, a signed-out athlete, an athlete who did
    // not enter this edition — opens on the board, because that is the only
    // thing there is for them.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const m = signedIn ? await loadMine().catch(() => null) : null;
                if (cancelled) return;
                if (m?.mine?.length) {
                    setView("mine");
                } else {
                    setView("board");
                    await loadBoard();
                }
            } catch (e: any) {
                if (!cancelled) setErr(e.message);
            } finally {
                if (!cancelled) {
                    first.current = false;
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [eventId, signedIn, loadMine, loadBoard]);

    // Refresh whichever view is showing, and only that one: polling the board
    // in the background while somebody reads their own result would be the
    // download this page is built to avoid.
    useEffect(() => {
        const tick = () => {
            const p = view === "mine" ? loadMine() : loadBoard();
            void p.catch(() => {
                /* kept quiet on purpose — see `first` */
            });
        };
        const timer = setInterval(tick, REFRESH_MS);
        return () => clearInterval(timer);
    }, [view, loadMine, loadBoard]);

    // The event's own name, so a page with nothing published still says which
    // race it is not showing results for.
    useEffect(() => {
        void fetch(`/api/hyfit-judge/public/events/${eventId}`, { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => d?.event?.name && setEventName(d.event.name))
            .catch(() => {});
    }, [eventId]);

    const showBoard = async () => {
        setView("board");
        setErr("");
        if (!board) {
            setLoading(true);
            try {
                await loadBoard();
            } catch (e: any) {
                setErr(e.message);
            } finally {
                setLoading(false);
            }
        }
    };

    const categories = useMemo(() => {
        const names = new Set<string>();
        for (const r of board?.rows ?? []) if (r.category) names.add(r.category);
        return [...names].sort();
    }, [board]);

    const boardRows = useMemo(
        () => (board?.rows ?? []).filter((r) => category === "all" || r.category === category),
        [board, category],
    );

    const isLive = (mine?.results_status ?? board?.source) === "live";
    const stamp = view === "mine" ? mine?.updated_at : board?.fetched_at;
    const title = mine?.event_name || board?.event_name || eventName || "Results";
    const hasMine = Boolean(mine?.mine?.length);

    /* Back, for the two ways somebody arrives here.
     *
     * An athlete taps through from the home page, so the history stack is the
     * right thing to walk. A spectator opens a shared link cold and has nothing
     * behind them — `router.back()` there either does nothing or leaves the app
     * entirely, so they get sent to the athlete home instead. */
    const goBack = () => {
        if (typeof window !== "undefined" && window.history.length > 1) router.back();
        else router.push(appPath("/hyfitgames"));
    };

    return (
        /* The same column as every other athlete screen: `max-w-md`, and the
           bottom padding that keeps the last card clear of the nav bar. This
           page cannot live inside the (app) layout that would give it both for
           free — that layout is gated behind an athlete session, and the whole
           point of this one is that a spectator with no login can read it. So
           the chrome is reproduced here, deliberately and visibly. */
        <div className="hfg-app mx-auto min-h-dvh max-w-md px-4 pb-24 pt-4">
            <div className="flex items-center justify-between gap-3">
                <button
                    onClick={goBack}
                    aria-label="Back"
                    className="-ml-1 flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk"
                >
                    <span aria-hidden className="text-base leading-none">
                        ←
                    </span>
                    Back
                </button>
                <HfgThemeToggle className="!px-2 !py-1.5" />
            </div>

            <div className="mt-2">
                <h1 className="text-2xl font-black uppercase tracking-wide">{title}</h1>
                {stamp && (
                    <p className="mt-1 text-xs text-fog">
                        {isLive ? (
                            <>
                                <span className="font-bold uppercase tracking-widest text-hyred-ink">Live</span> ·
                                provisional · updated {new Date(stamp).toLocaleTimeString()}
                            </>
                        ) : (
                            <>Official · published {new Date(stamp).toLocaleString()}</>
                        )}
                    </p>
                )}
            </div>

            {/* The toggle only exists for somebody who has a result here. For
                everyone else there is one view and a switch would be a control
                that does nothing. */}
            {hasMine && (
                <div className="mt-4 flex gap-2">
                    <button
                        onClick={() => {
                            setView("mine");
                            setErr("");
                        }}
                        className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold uppercase tracking-wide ${
                            view === "mine" ? "bg-hyred text-onfill" : "border border-smoke text-fog"
                        }`}
                    >
                        My result
                    </button>
                    <button
                        onClick={() => void showBoard()}
                        className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold uppercase tracking-wide ${
                            view === "board" ? "bg-hyred text-onfill" : "border border-smoke text-fog"
                        }`}
                    >
                        Leaderboard
                    </button>
                </div>
            )}

            {loading ? (
                <Spinner />
            ) : err ? (
                <Empty title="Results unavailable" hint={err} />
            ) : view === "mine" ? (
                <div className="mt-4 space-y-3">
                    {mine!.mine.map((entry) => (
                        <MyResult
                            key={entry.entry_id}
                            entry={entry}
                            fieldSize={entry.row?.category ? mine!.field[entry.row.category] : undefined}
                        />
                    ))}
                    {!hasMine && <Empty title="You have no entry at this event" />}
                </div>
            ) : !board ? (
                <Empty
                    title="No results published yet"
                    hint="Standings appear here once the organiser publishes them."
                />
            ) : (
                <>
                    {categories.length > 1 && (
                        <div className="mt-4 flex flex-wrap gap-2">
                            {["all", ...categories].map((name) => (
                                <button
                                    key={name}
                                    onClick={() => setCategory(name)}
                                    className={`rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-widest ${
                                        category === name ? "bg-hyred text-onfill" : "border border-smoke text-fog"
                                    }`}
                                >
                                    {name === "all" ? "All" : name}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="mt-4 space-y-2">
                        {boardRows.map((r) => (
                            <ResultCard
                                key={rowKey(r)}
                                row={r}
                                open={open === rowKey(r)}
                                onToggle={() => setOpen(open === rowKey(r) ? null : rowKey(r))}
                            />
                        ))}
                        {!boardRows.length && <Empty title="Nothing in this category yet" />}
                    </div>
                </>
            )}

            {/* Only for somebody signed in. Every destination on it — Home, My
                Journey, Profile — is behind the athlete session, so showing it
                to a spectator would be three links into a login wall from a
                page that deliberately does not need one. */}
            {signedIn && <BottomNav />}
        </div>
    );
}

/* Your own result, opened out.
 *
 * Not the same component as a leaderboard row and deliberately so: a
 * leaderboard row is one of a thousand and has to be scannable, while this is
 * the only thing on the screen and is the reason the athlete came. The circuit
 * is always expanded, the placing carries its field size, and an entry with no
 * row yet says so rather than rendering as a blank.
 */
function MyResult({
    entry,
    fieldSize,
}: {
    entry: Mine["mine"][number];
    fieldSize?: number;
}) {
    const row = entry.row;
    const finished = row?.status === "FIN";

    return (
        <div className="rounded-2xl border border-smoke bg-gradient-to-br from-coal to-ink p-5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-widest text-fog">
                        Bib {entry.bib}
                        {entry.category ? ` · ${entry.category}` : ""}
                    </p>
                    <p className="mt-2 text-4xl font-black">
                        {row ? (finished ? fmtMs(row.total_ms) : row.status) : "—"}
                    </p>
                </div>
                {row && (
                    <div className="text-right">
                        {row.rank ? (
                            <>
                                <p className="text-3xl font-black text-hyred-ink">#{row.rank}</p>
                                {fieldSize ? <p className="text-xs text-fog">of {fieldSize}</p> : null}
                            </>
                        ) : (
                            <Chip>{row.status}</Chip>
                        )}
                    </div>
                )}
            </div>

            {!row && (
                <p className="mt-3 text-sm text-fog">
                    No result for this bib yet. It appears here as soon as the organiser publishes it.
                </p>
            )}

            {/* A pair's own result is two numbers, and both are theirs: their
                own leg, and the team's. */}
            {row?.team_time_ms != null && (
                <div className="mt-3 flex items-baseline gap-2 border-t border-smoke pt-3">
                    <span className="text-xs font-bold uppercase tracking-widest text-fog">Team</span>
                    <span className="text-xl font-black">{fmtMs(row.team_time_ms)}</span>
                    {entry.club && <span className="text-sm text-fog">· {entry.club}</span>}
                </div>
            )}

            {row?.age_group_rank != null && (
                <p className="mt-3 text-xs text-fog">Age group placing #{row.age_group_rank}</p>
            )}

            {row && (
                <div className="mt-4 border-t border-smoke pt-4">
                    <SplitTimeline source={row} />
                </div>
            )}
        </div>
    );
}

/* One athlete on the leaderboard. Collapsed it is a standings line; opened it
 * is their circuit. */
function ResultCard({ row, open, onToggle }: { row: Row; open: boolean; onToggle: () => void }) {
    const finished = row.status === "FIN";

    return (
        <div className="rounded-xl border border-smoke bg-coal">
            <button onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-3 text-left">
                <span className="w-8 shrink-0 text-center text-lg font-black text-hyred-ink">{row.rank ?? "—"}</span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{row.name || `Bib ${row.bib}`}</span>
                    <span className="block truncate text-xs text-fog">
                        {row.bib}
                        {row.category ? ` · ${row.category}` : ""}
                        {row.club ? ` · ${row.club}` : ""}
                    </span>
                </span>
                <span className="shrink-0 text-right">
                    <span className="block font-mono text-base">{finished ? fmtMs(row.total_ms) : row.status}</span>
                    {row.team_time_ms !== null && (
                        <span className="block text-xs text-fog">Team {fmtMs(row.team_time_ms)}</span>
                    )}
                </span>
            </button>

            {open && (
                <div className="border-t border-smoke px-3 py-3">
                    {row.age_group_rank !== null && (
                        <p className="mb-3 text-xs text-fog">Age group placing #{row.age_group_rank}</p>
                    )}
                    <SplitTimeline source={row} />
                </div>
            )}
        </div>
    );
}
