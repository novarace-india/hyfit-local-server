"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, fmtMs, fmtDate } from "../../../../../lib/api";
import { Spinner, statusChip, ErrorNote } from "../../../../../lib/ui";

const ZONES = [
    "Cognitive Start",
    ...Array.from({ length: 6 }, (_, i) => `Station ${i + 1}`),
    "Cognitive Finish",
];

// Comprehensive scorecard. Ported from pages/Scorecard.jsx.
export default function Scorecard() {
    const { id: eventId, regId } = useParams<{ id: string; regId: string }>();
    const [data, setData] = useState<any>(null);
    const [err, setErr] = useState("");

    useEffect(() => {
        api(`/events/${eventId}/scorecard/${regId}`)
            .then(setData)
            .catch((e) => setErr(e.message));
    }, [eventId, regId]);

    if (err) return <main className="px-5 pt-6"><ErrorNote msg={err} /></main>;
    if (!data) return <Spinner />;

    const { athlete, splits, stationBests, winner, participants } = data;
    const totalTime = athlete.total_ms;
    const fastestSplit = splits.length ? Math.min(...splits.map((s: any) => s.split_ms)) : 0;
    const slowestSplit = splits.length ? Math.max(...splits.map((s: any) => s.split_ms)) : 0;
    const gapToWinner = winner && totalTime ? totalTime - winner.total_ms : null;
    const splitTimes = splits.map((s: any) => s.split_ms);
    const avgSplit = splitTimes.length
        ? Math.round(splitTimes.reduce((a: number, b: number) => a + b, 0) / splitTimes.length)
        : 0;

    return (
        <main className="px-5 pt-6 pb-10">
            <Link href={`/hyfitgames/events/${eventId}`} className="text-sm text-fog">
                ← Race hub
            </Link>

            {/* Hero */}
            <div className="mt-4 rounded-2xl border border-hyred/30 bg-gradient-to-br from-hyred/10 to-transparent p-5 text-center">
                <div className="flex items-center justify-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-fog">Bib</span>
                    <span className="text-3xl font-black text-hyred-ink">{athlete.bib}</span>
                </div>
                <h1 className="mt-2 text-xl font-black uppercase tracking-wide">{athlete.full_name}</h1>
                <p className="mt-0.5 text-xs text-fog">
                    {athlete.wave} · {athlete.gender === "male" ? "M" : "F"} · {athlete.city || "—"}
                </p>
                <div className="mt-1">{statusChip(athlete.status)}</div>

                <div className="mt-4">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-fog">
                        {athlete.results_status === "final" ? "Official Time" : "Total Time"}
                    </p>
                    <p className="text-5xl font-black text-hyred-ink">{fmtMs(totalTime)}</p>
                </div>

                {gapToWinner != null && gapToWinner > 0 && (
                    <p className="mt-1 text-xs text-fog">
                        +{fmtMs(gapToWinner)} behind {winner.full_name}
                    </p>
                )}
                {gapToWinner === 0 && <p className="mt-1 text-xs font-bold text-hyred-ink">Race winner</p>}
            </div>

            {/* Doubles: the team's time and every member's own leg. The
                scorecard is the detailed view of a result, so it is the last
                place a pair should read as one anonymous number. */}
            {athlete.team_name && (
                <div className="mt-4 rounded-2xl border border-hyred/40 bg-hyred/10 p-4">
                    <div className="flex items-baseline justify-between gap-3">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-fog">
                            Team · {athlete.category}
                        </p>
                        <p className="text-xs text-fog">{athlete.team_name}</p>
                    </div>
                    <div className="mt-1 flex items-baseline gap-3">
                        <p className="text-3xl font-black text-hyred-ink">
                            {athlete.team_total_ms ? fmtMs(athlete.team_total_ms) : "—"}
                        </p>
                        <p className="text-sm font-black">
                            {athlete.team_rank ? `#${athlete.team_rank}` : ""}
                        </p>
                    </div>
                    <div className="mt-2 divide-y divide-smoke/60 border-t border-smoke/60">
                        {(athlete.team_members ?? []).map((m: any) => (
                            <div key={m.registration_id} className="flex items-center gap-3 py-1.5 text-sm">
                                <span className="w-10 shrink-0 font-mono text-xs text-fog">{m.bib}</span>
                                <span className="min-w-0 flex-1 truncate font-semibold">
                                    {m.full_name}
                                    {m.is_self && (
                                        <span className="ml-1.5 rounded bg-smoke px-1.5 py-0.5 text-[10px] font-bold uppercase">
                                            This card
                                        </span>
                                    )}
                                </span>
                                <span className="shrink-0 font-black">
                                    {m.total_ms ? fmtMs(m.total_ms) : m.status}
                                </span>
                                <span className="w-10 shrink-0 text-right text-xs text-fog">
                                    {m.category_rank ? `#${m.category_rank}` : "—"}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Rank Badges */}
            <div className="mt-4 grid grid-cols-3 gap-3">
                {[
                    ["#" + (athlete.overall_rank || "—"), athlete.category || "Category", ""],
                    ["#" + (athlete.gender_rank || "—"), athlete.gender === "male" ? "Male" : "Female", ""],
                    ["#" + (athlete.age_group_rank || "—"), athlete.age_group || "Age", ""],
                ].map(([rank, label, sub]) => (
                    <div key={label} className="rounded-xl border border-smoke bg-coal p-3 text-center">
                        <p className="text-2xl font-black text-hyred-ink">{rank}</p>
                        <p className="text-[11px] font-bold uppercase tracking-wide text-fog">{label}</p>
                        {sub && <p className="text-[10px] text-fog">{sub}</p>}
                    </div>
                ))}
            </div>

            {/* Race Timeline */}
            <h2 className="mb-3 mt-7 text-xs font-bold uppercase tracking-[0.18em] text-fog">Race Timeline</h2>
            <div className="overflow-x-auto pb-2">
                <div className="flex gap-1.5 min-w-[540px]">
                    {ZONES.map((zone, i) => {
                        const isStart = i === 0;
                        const isFinish = i === ZONES.length - 1;
                        const split = !isStart && !isFinish ? splits[i - 1] : null;
                        const best = !isStart && !isFinish ? stationBests[i - 1] : null;
                        const isCompleted = !!split;
                        const isCurrent = !isCompleted && (i === 0 || !!splits[i - 2]);
                        const isFastest = split && split.split_ms === fastestSplit;

                        return (
                            <div key={zone} className="flex-1 min-w-[72px]">
                                <div
                                    className={`relative rounded-lg border p-2 text-center transition-colors ${
                                        isCompleted
                                            ? isFastest
                                                ? "border-hyred bg-hyred/10"
                                                : "border-smoke bg-coal"
                                            : isCurrent
                                              ? "border-hyred/50 bg-hyred/5 animate-pulse"
                                              : "border-smoke/50 bg-smoke/20"
                                    }`}
                                >
                                    <p className="text-[9px] font-bold uppercase tracking-wider text-fog">{zone}</p>
                                    <p
                                        className={`mt-1 text-xs font-black ${
                                            isCompleted ? "text-chalk" : isCurrent ? "text-hyred-ink" : "text-fog"
                                        }`}
                                    >
                                        {isStart
                                            ? "0:00"
                                            : isFinish
                                              ? fmtMs(totalTime)
                                              : split
                                                ? fmtMs(split.split_ms)
                                                : "—"}
                                    </p>
                                    {isCompleted && (
                                        <div className="mt-1 h-1 rounded-full bg-smoke overflow-hidden">
                                            <div
                                                className={`h-full rounded-full ${isFastest ? "bg-hyred" : "bg-fog/40"}`}
                                                style={{
                                                    width: `${
                                                        best
                                                            ? Math.max(
                                                                  10,
                                                                  (1 -
                                                                      (split.split_ms - best.best_ms) /
                                                                          (best.worst_ms - best.best_ms || 1)) *
                                                                      100,
                                                              )
                                                            : 50
                                                    }%`,
                                                }}
                                            />
                                        </div>
                                    )}
                                    {isFastest && <p className="mt-0.5 text-[8px] font-bold text-hyred-ink">FASTEST</p>}
                                    {!isStart && !isFinish && best && (
                                        <p className="text-[8px] text-fog">avg {fmtMs(best.avg_ms)}</p>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Station Breakdown */}
            <h2 className="mb-3 mt-7 text-xs font-bold uppercase tracking-[0.18em] text-fog">Station Breakdown</h2>
            <div className="space-y-2">
                {splits.map((s: any) => {
                    const best = stationBests.find((b: any) => b.seq === s.seq);
                    const pct = best
                        ? Math.max(8, ((best.worst_ms - s.split_ms) / (best.worst_ms - best.best_ms || 1)) * 100)
                        : 50;
                    const isFastest = s.split_ms === fastestSplit;
                    const isSlowest = s.split_ms === slowestSplit && splits.length > 1;
                    const gap = best ? s.split_ms - best.best_ms : 0;

                    return (
                        <div key={s.seq} className="rounded-xl border border-smoke bg-coal p-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2.5">
                                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-smoke text-xs font-black text-chalk">
                                        {s.seq}
                                    </span>
                                    <div>
                                        <p className="text-sm font-bold">{s.name}</p>
                                        <p className="text-[10px] text-fog">Cumulative {fmtMs(s.cum_ms)}</p>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <p
                                        className={`text-lg font-black ${
                                            isFastest ? "text-hyred-ink" : isSlowest ? "text-warn" : "text-chalk"
                                        }`}
                                    >
                                        {fmtMs(s.split_ms)}
                                    </p>
                                    <p className="text-[10px] text-fog">
                                        {s.station_rank}/{s.station_total}
                                        {gap > 0 && <span className="text-warn"> +{fmtMs(gap)}</span>}
                                    </p>
                                </div>
                            </div>
                            <div className="mt-2 h-1.5 rounded-full bg-smoke/50 overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${
                                        isFastest ? "bg-hyred" : isSlowest ? "bg-warn" : "bg-fog/50"
                                    }`}
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Performance Summary */}
            {splits.length > 0 && (
                <>
                    <h2 className="mb-3 mt-7 text-xs font-bold uppercase tracking-[0.18em] text-fog">
                        Performance Summary
                    </h2>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-xl border border-smoke bg-coal p-3 text-center">
                            <p className="text-lg font-black text-hyred-ink">{fmtMs(fastestSplit)}</p>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Fastest Station</p>
                            <p className="text-[10px] text-fog">
                                {splits.find((s: any) => s.split_ms === fastestSplit)?.name}
                            </p>
                        </div>
                        <div className="rounded-xl border border-smoke bg-coal p-3 text-center">
                            <p className="text-lg font-black text-warn">{fmtMs(slowestSplit)}</p>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Slowest Station</p>
                            <p className="text-[10px] text-fog">
                                {splits.find((s: any) => s.split_ms === slowestSplit)?.name}
                            </p>
                        </div>
                        <div className="rounded-xl border border-smoke bg-coal p-3 text-center">
                            <p className="text-lg font-black">{fmtMs(avgSplit)}</p>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Avg Station</p>
                        </div>
                        <div className="rounded-xl border border-smoke bg-coal p-3 text-center">
                            <p className="text-lg font-black">{participants.total}</p>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Participants</p>
                        </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-smoke bg-coal p-3">
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-bold uppercase tracking-wide text-fog">Consistency</p>
                            <p className="text-xs font-black">
                                {(() => {
                                    const spread = slowestSplit - fastestSplit;
                                    if (spread < 30000) return <span className="text-good">Excellent</span>;
                                    if (spread < 60000) return <span className="text-warn">Good</span>;
                                    return <span className="text-warn">Variable</span>;
                                })()}
                            </p>
                        </div>
                        <div className="mt-2 flex items-end gap-0.5">
                            {splits.map((s: any) => {
                                const range = slowestSplit - fastestSplit || 1;
                                const h = Math.max(4, ((s.split_ms - fastestSplit) / range) * 24 + 4);
                                const isF = s.split_ms === fastestSplit;
                                const isS = s.split_ms === slowestSplit;
                                return (
                                    <div key={s.seq} className="flex-1 flex flex-col items-center gap-0.5">
                                        <div
                                            className={`w-full rounded-sm ${
                                                isF ? "bg-hyred" : isS ? "bg-warn" : "bg-fog/30"
                                            }`}
                                            style={{ height: `${h}px` }}
                                        />
                                        <span className="text-[8px] text-fog">{s.seq}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}

            {/* Footer */}
            <div className="mt-8 rounded-2xl border border-smoke bg-coal p-4 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src="/hyfitgames/hyfit-logo-red-SMZJ9JPG.png"
                    alt="HYFIT"
                    className="mx-auto max-h-8 w-auto object-contain"
                />
                <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.15em] text-fog">
                    {athlete.event_name} · {fmtDate(athlete.event_date)}
                </p>
                <p className="mt-1 text-[10px] text-fog">{athlete.venue || athlete.event_city}</p>
            </div>
        </main>
    );
}
