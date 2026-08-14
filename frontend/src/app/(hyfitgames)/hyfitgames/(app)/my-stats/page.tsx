"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, fmtMs, fmtDate, appPath } from "../../lib/api";
import { Spinner, ErrorNote } from "../../lib/ui";

// Rich performance dashboard. Ported from pages/PersonalStats.jsx.
function Badge({ children, color = "fog" }: { children: React.ReactNode; color?: string }) {
    const c: Record<string, string> = {
        fog: "bg-smoke text-fog",
        hyred: "bg-hyred/20 text-hyred-ink",
        gold: "bg-warn-soft text-warn",
        emerald: "bg-good-soft text-good",
    };
    return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${c[color]}`}>
            {children}
        </span>
    );
}

function Ring({
    value,
    max,
    label,
    sub,
    color = "var(--color-hyred)",
}: {
    value: any;
    max?: any;
    label: string;
    sub?: string;
    color?: string;
}) {
    const pct = Math.min((typeof value === "number" ? value : 0) / (max || 1), 1);
    const r = 34,
        c = 2 * Math.PI * r;
    return (
        <div className="flex flex-col items-center">
            <svg width="80" height="80" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r={r} fill="none" stroke="var(--color-track)" strokeWidth="6" />
                <circle
                    cx="40"
                    cy="40"
                    r={r}
                    fill="none"
                    stroke={color}
                    strokeWidth="6"
                    strokeDasharray={c}
                    strokeDashoffset={c * (1 - pct)}
                    strokeLinecap="round"
                    transform="rotate(-90 40 40)"
                />
                <text
                    x="40"
                    y="40"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--color-chalk)"
                    fontSize="16"
                    fontWeight="900"
                    fontFamily="Arial"
                >
                    {typeof value === "number" && value > 999 ? fmtMs(value) : value}
                </text>
            </svg>
            <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-fog">{label}</p>
            {sub && <p className="text-[9px] text-fog">{sub}</p>}
        </div>
    );
}

function MiniLine({ points, width = 200, height = 40, color = "var(--color-hyred)" }: { points: number[]; width?: number; height?: number; color?: string }) {
    if (points.length < 2) return null;
    const min = Math.min(...points),
        max = Math.max(...points);
    const range = max - min || 1;
    const coords = points.map(
        (p, i) => `${(i / (points.length - 1)) * width},${height - ((p - min) / range) * (height - 4) - 2}`,
    );
    return (
        <svg width={width} height={height} className="w-full">
            <polyline fill="none" stroke={color} strokeWidth="1.5" points={coords.join(" ")} />
        </svg>
    );
}

export default function PersonalStats() {
    const [data, setData] = useState<any>(null);
    const [err, setErr] = useState("");
    const [tab, setTab] = useState("overview");

    useEffect(() => {
        api("/me/full-stats").then(setData).catch((e) => setErr(e.message));
    }, []);

    if (err) return <main className="px-5 pt-6"><ErrorNote msg={err} /></main>;
    if (!data) return <Spinner />;

    const {
        athlete,
        core,
        cityBreakdown,
        progression,
        stationPerf,
        stationTrend,
        monthlyPerf,
        percentile,
        consistency,
        streaks,
        genderRank,
    } = data;

    const badges: { label: string; color: string }[] = [];
    if (core.wins >= 1) badges.push({ label: "Champion", color: "gold" });
    if (core.podiums >= 10) badges.push({ label: "Podium Machine", color: "gold" });
    if (core.cities_visited >= 10) badges.push({ label: "Road Warrior", color: "hyred" });
    if (core.cities_visited >= 15) badges.push({ label: "India Explorer", color: "emerald" });
    if (core.total_events >= 25) badges.push({ label: "25+ Editions", color: "hyred" });
    if (core.total_events >= 50) badges.push({ label: "Half Century", color: "gold" });
    if (streaks.longest >= 5) badges.push({ label: `${streaks.longest}x Streak`, color: "emerald" });
    if (percentile >= 90) badges.push({ label: "Top 10%", color: "gold" });
    if (core.wins >= 3) badges.push({ label: "Triple Crown", color: "gold" });

    const progressionTimes = progression.map((p: any) => p.total_ms);

    const tabs = [
        { id: "overview", label: "Overview" },
        { id: "stations", label: "Stations" },
        { id: "cities", label: "Cities" },
        { id: "journey", label: "Journey" },
    ];

    return (
        <main className="px-5 pt-6 pb-10">
            <Link href={appPath("/hyfitgames/profile")} className="text-sm text-fog">
                ← Profile
            </Link>

            {/* Hero */}
            <div className="mt-4 rounded-2xl border border-hyred/30 bg-gradient-to-br from-hyred/10 to-transparent p-5">
                <div className="flex items-center gap-3">
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-hyred text-2xl font-black text-onfill">
                        {athlete.full_name
                            .split(" ")
                            .map((n: string) => n[0])
                            .join("")}
                    </div>
                    <div>
                        <h1 className="text-xl font-black uppercase tracking-wide">{athlete.full_name}</h1>
                        <p className="text-xs text-fog">
                            {athlete.city} · {athlete.gender === "male" ? "M" : "F"} · Member since 2025
                        </p>
                    </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {badges.map((b, i) => (
                        <Badge key={i} color={b.color}>
                            {b.label}
                        </Badge>
                    ))}
                </div>
            </div>

            {/* Core Numbers */}
            <div className="mt-5 grid grid-cols-4 gap-2">
                {[
                    [core.total_events, "Events"],
                    [core.finishes, "Finishes"],
                    [core.wins, "Wins"],
                    [core.podiums, "Podiums"],
                ].map(([v, l]) => (
                    <div key={l as string} className="rounded-xl bg-coal p-2.5 text-center">
                        <p className="text-xl font-black text-hyred-ink">{v}</p>
                        <p className="text-[9px] font-bold uppercase tracking-wide text-fog">{l}</p>
                    </div>
                ))}
            </div>

            {/* Rings Row */}
            <div className="mt-4 flex justify-around">
                <Ring value={fmtMs(core.pb_ms)} max="—" label="PB" sub="Personal Best" />
                <Ring
                    value={`${(100 - (percentile || 0)).toFixed(0)}%`}
                    label="Faster"
                    sub={`than ${percentile}% of athletes`}
                    color="var(--color-teal)"
                />
                <Ring value={streaks.current} max={streaks.longest} label="Streak" sub={`Best: ${streaks.longest}`} color="var(--color-hyred)" />
            </div>

            {/* Tab Navigation */}
            <div className="mt-6 flex gap-1 rounded-xl bg-coal p-1">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`flex-1 rounded-lg py-1.5 text-[11px] font-bold uppercase tracking-wide transition-colors ${
                            tab === t.id ? "bg-hyred text-onfill" : "text-fog"
                        }`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {tab === "overview" && (
                <>
                    <div className="mt-4 rounded-xl border border-smoke bg-coal p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Performance Trend</p>
                        <div className="mt-2">
                            <MiniLine points={progressionTimes} />
                        </div>
                        <div className="mt-1 flex justify-between text-[9px] text-fog">
                            <span>
                                {progression[0]?.city} #{progression[0]?.edition}
                            </span>
                            <span>
                                {progression[progression.length - 1]?.city} #
                                {progression[progression.length - 1]?.edition}
                            </span>
                        </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                        <div className="rounded-xl border border-smoke bg-coal p-3">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Average Time</p>
                            <p className="mt-1 text-lg font-black">{fmtMs(core.avg_ms)}</p>
                        </div>
                        <div className="rounded-xl border border-smoke bg-coal p-3">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Average Rank</p>
                            <p className="mt-1 text-lg font-black">#{core.avg_rank || "—"}</p>
                        </div>
                        <div className="rounded-xl border border-smoke bg-coal p-3">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Gender Wins</p>
                            <p className="mt-1 text-lg font-black text-hyred-ink">{genderRank.gender_wins}</p>
                            <p className="text-[9px] text-fog">Avg rank: #{genderRank.avg_gender_rank}</p>
                        </div>
                        <div className="rounded-xl border border-smoke bg-coal p-3">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Cities Visited</p>
                            <p className="mt-1 text-lg font-black">{core.cities_visited}</p>
                            <p className="text-[9px] text-fog">{core.dnfs} DNFs</p>
                        </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-smoke bg-coal p-3">
                        <div className="flex items-center justify-between">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Consistency</p>
                            <Badge color={consistency.std_dev < 30000 ? "emerald" : consistency.std_dev < 60000 ? "gold" : "fog"}>
                                {consistency.std_dev < 30000 ? "Rock Solid" : consistency.std_dev < 60000 ? "Solid" : "Variable"}
                            </Badge>
                        </div>
                        <div className="mt-1 text-sm text-fog">
                            Std dev: {(consistency.std_dev / 1000).toFixed(1)}s across {consistency.n} finishes
                        </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-smoke bg-coal p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Monthly Activity</p>
                        <div className="mt-2 grid grid-cols-6 gap-1">
                            {monthlyPerf.map((m: any) => {
                                const intensity = Math.min(m.events / 6, 1);
                                return (
                                    <div key={m.month} className="text-center">
                                        <div
                                            className="mx-auto aspect-square rounded-md"
                                            style={{ backgroundColor: `color-mix(in srgb, var(--color-hyred) ${Math.round((0.15 + intensity * 0.85) * 100)}%, transparent)` }}
                                        />
                                        <p className="mt-0.5 text-[8px] text-fog">{m.month.slice(5)}</p>
                                        <p className="text-[8px] text-fog">{m.events}</p>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}

            {tab === "stations" && (
                <>
                    <h2 className="mb-3 mt-4 text-xs font-bold uppercase tracking-[0.18em] text-fog">Station Mastery</h2>
                    <div className="space-y-2">
                        {stationPerf.map((s: any) => {
                            const rankPct =
                                s.best_rank_in_station && s.total_athletes_at_station
                                    ? Math.round(
                                          (1 - (Number(s.best_rank_in_station) - 1) / Number(s.total_athletes_at_station)) *
                                              100,
                                      )
                                    : 50;
                            return (
                                <div key={s.seq} className="rounded-xl border border-smoke bg-coal p-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2.5">
                                            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-smoke text-xs font-black text-chalk">
                                                {s.seq}
                                            </span>
                                            <div>
                                                <p className="text-sm font-bold">{s.name}</p>
                                                <p className="text-[9px] text-fog">
                                                    {s.attempts} races · Rank #{s.best_rank_in_station}/
                                                    {s.total_athletes_at_station}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-lg font-black text-hyred-ink">{fmtMs(s.best_ms)}</p>
                                            <p className="text-[9px] text-fog">avg {fmtMs(s.avg_ms)}</p>
                                        </div>
                                    </div>
                                    <div className="mt-2 h-1.5 rounded-full bg-smoke/50 overflow-hidden">
                                        <div className="h-full rounded-full bg-hyred" style={{ width: `${rankPct}%` }} />
                                    </div>
                                    <div className="mt-1 flex justify-between text-[8px] text-fog">
                                        <span>Best: {fmtMs(s.best_ms)}</span>
                                        <span>Worst: {fmtMs(s.worst_ms)}</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {stationPerf.length >= 2 && (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                            <div className="rounded-xl border border-good/30 bg-good-soft p-3 text-center">
                                <p className="text-[10px] font-bold uppercase tracking-wide text-good">
                                    Strongest Station
                                </p>
                                <p className="mt-1 text-sm font-black text-chalk">
                                    {
                                        stationPerf.reduce((a: any, b: any) =>
                                            Number(a.best_rank_in_station) <= Number(b.best_rank_in_station) ? a : b,
                                        ).name
                                    }
                                </p>
                            </div>
                            <div className="rounded-xl border border-warn/40 bg-warn-soft p-3 text-center">
                                <p className="text-[10px] font-bold uppercase tracking-wide text-warn">Work On</p>
                                <p className="mt-1 text-sm font-black text-chalk">
                                    {
                                        stationPerf.reduce((a: any, b: any) =>
                                            Number(a.best_rank_in_station) >= Number(b.best_rank_in_station) ? a : b,
                                        ).name
                                    }
                                </p>
                            </div>
                        </div>
                    )}

                    <h2 className="mb-3 mt-6 text-xs font-bold uppercase tracking-[0.18em] text-fog">Station Trends</h2>
                    <div className="grid grid-cols-2 gap-2">
                        {stationPerf.map((s: any) => {
                            const stationPoints = stationTrend
                                .filter((t: any) => t.seq === s.seq)
                                .map((t: any) => t.split_ms);
                            return (
                                <div key={s.seq} className="rounded-xl border border-smoke bg-coal p-2">
                                    <p className="text-[9px] font-bold text-fog">{s.name}</p>
                                    <div className="mt-1">
                                        <MiniLine points={stationPoints} height={32} />
                                    </div>
                                    <p className="mt-0.5 text-[8px] text-fog">{fmtMs(s.best_ms)} best</p>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}

            {tab === "cities" && (
                <>
                    <h2 className="mb-3 mt-4 text-xs font-bold uppercase tracking-[0.18em] text-fog">City Performance</h2>
                    <div className="space-y-2">
                        {cityBreakdown.map((c: any) => {
                            const bestInCity = Math.min(...cityBreakdown.map((x: any) => x.best_ms));
                            const worstInCity = Math.max(...cityBreakdown.map((x: any) => x.best_ms));
                            const range = worstInCity - bestInCity || 1;
                            const pct = ((worstInCity - c.best_ms) / range) * 100;
                            return (
                                <div key={c.city} className="rounded-xl border border-smoke bg-coal p-3">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-sm font-bold">{c.city}</p>
                                            <p className="text-[9px] text-fog">
                                                {c.events} events · Avg #{c.avg_rank}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-lg font-black text-hyred-ink">{fmtMs(c.best_ms)}</p>
                                            {c.wins > 0 && (
                                                <Badge color="gold">
                                                    {c.wins} win{c.wins > 1 ? "s" : ""}
                                                </Badge>
                                            )}
                                        </div>
                                    </div>
                                    <div className="mt-2 h-1.5 rounded-full bg-smoke/50 overflow-hidden">
                                        <div className="h-full rounded-full bg-hyred" style={{ width: `${Math.max(pct, 5)}%` }} />
                                    </div>
                                    {c.podiums > 0 && (
                                        <p className="mt-1 text-[9px] text-fog">
                                            {c.podiums} podium{c.podiums > 1 ? "s" : ""} in {c.city}
                                        </p>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </>
            )}

            {tab === "journey" && (
                <>
                    <h2 className="mb-3 mt-4 text-xs font-bold uppercase tracking-[0.18em] text-fog">Race Journey</h2>
                    <div className="rounded-xl border border-smoke bg-coal p-3">
                        <div className="h-48">
                            <MiniLine points={progressionTimes} width={400} height={180} />
                        </div>
                        <div className="mt-2 flex justify-between text-[9px] text-fog">
                            <span>
                                Edition #{progression[0]?.edition} — {progression[0]?.city}
                            </span>
                            <span>
                                Edition #{progression[progression.length - 1]?.edition} —{" "}
                                {progression[progression.length - 1]?.city}
                            </span>
                        </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-smoke bg-coal p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-fog">Progression Insight</p>
                        {progression.length >= 2 && (
                            <p className="mt-1 text-sm text-chalk">
                                {progression[progression.length - 1].total_ms < progression[0].total_ms
                                    ? `You're ${fmtMs(
                                          progression[0].total_ms - progression[progression.length - 1].total_ms,
                                      )} faster than your first edition. That's a ${Math.round(
                                          (1 - progression[progression.length - 1].total_ms / progression[0].total_ms) *
                                              100,
                                      )}% improvement.`
                                    : `You've stayed remarkably consistent. Your times have varied by only ${fmtMs(
                                          Math.abs(
                                              progression[progression.length - 1].total_ms - progression[0].total_ms,
                                          ),
                                      )}.`}
                            </p>
                        )}
                    </div>

                    <h2 className="mb-3 mt-6 text-xs font-bold uppercase tracking-[0.18em] text-fog">All Editions</h2>
                    <div className="space-y-1.5">
                        {progression.map((p: any, i: number) => (
                            <div key={i} className="flex items-center gap-3 rounded-lg bg-coal px-3 py-2">
                                <span className="w-6 text-center text-[10px] font-black text-fog">#{p.edition}</span>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-semibold">{p.city}</p>
                                    <p className="text-[9px] text-fog">{fmtDate(p.date)}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm font-black">{fmtMs(p.total_ms)}</p>
                                    <p className="text-[9px] text-fog">#{p.overall_rank} overall</p>
                                </div>
                                {p.overall_rank <= 3 && <span className="text-warn">★</span>}
                            </div>
                        ))}
                    </div>
                </>
            )}

            {/* Footer */}
            <div className="mt-8 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src="/hyfitgames/hyfit-logo-red-SMZJ9JPG.png"
                    alt="HYFIT"
                    className="mx-auto max-h-6 w-auto object-contain opacity-40"
                />
            </div>
        </main>
    );
}
