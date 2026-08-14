"use client";
import { useEffect, useState } from "react";
import { api, fmtMs, fmtDate } from "../../lib/api";
import { Spinner, SectionTitle, Empty, ErrorNote } from "../../lib/ui";

// "My Journey" — cross-edition progression. Ported from pages/History.jsx.
export default function History() {
    const [stats, setStats] = useState<any>(null);
    const [err, setErr] = useState("");

    useEffect(() => {
        api("/me/stats").then(setStats).catch((e) => setErr(e.message));
    }, []);
    if (err) return <main className="p-5"><ErrorNote msg={err} /></main>;
    if (!stats) return <Spinner />;

    const prog = stats.progression;
    const maxMs = Math.max(...prog.map((p: any) => p.total_ms), 1);

    return (
        <main className="px-5 pt-6">
            <h1 className="text-3xl font-black tracking-wide">MY JOURNEY</h1>
            <p className="mt-1 text-sm text-fog">Every edition, every city — how you're progressing.</p>

            <SectionTitle>Editions</SectionTitle>
            {prog.length === 0 && (
                <Empty
                    title="No official finishes yet"
                    hint="Your progression chart builds as final results are published."
                />
            )}
            <div className="space-y-3">
                {prog.map((p: any) => (
                    <div key={p.event_date}>
                        <div className="flex justify-between text-sm">
                            <span>
                                {p.name} <span className="text-fog">· {p.city}</span>
                            </span>
                            <span className="font-black">{fmtMs(p.total_ms)}</span>
                        </div>
                        <div className="mt-1 h-2.5 rounded-full bg-coal">
                            <div
                                className="h-2.5 rounded-full bg-hyred"
                                style={{ width: `${Math.max((p.total_ms / maxMs) * 100, 6)}%` }}
                            />
                        </div>
                        <p className="mt-0.5 text-[11px] text-fog">
                            {fmtDate(p.event_date)} · Overall #{p.overall_rank}
                        </p>
                    </div>
                ))}
            </div>
            {prog.length >= 2 && (
                <p className="mt-3 text-sm text-fog">
                    {prog.at(-1).total_ms < prog[0].total_ms
                        ? `You're ${fmtMs(prog[0].total_ms - prog.at(-1).total_ms)} faster than your first edition. Keep going.`
                        : "Shorter bar = faster race. Chase that first-edition time."}
                </p>
            )}

            <SectionTitle>Station bests (all editions)</SectionTitle>
            {stats.stationBests.length === 0 && <Empty title="No station data yet" />}
            <div className="grid grid-cols-2 gap-3">
                {stats.stationBests.map((s: any) => (
                    <div key={s.name} className="rounded-xl bg-coal p-3">
                        <p className="text-xl font-black text-hyred-ink">{fmtMs(s.best_ms)}</p>
                        <p className="mt-0.5 text-xs text-fog">{s.name}</p>
                    </div>
                ))}
            </div>
        </main>
    );
}
