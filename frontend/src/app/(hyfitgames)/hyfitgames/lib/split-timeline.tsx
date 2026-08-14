"use client";

/* The HYFIT circuit, drawn.
 *
 * ONE renderer, used by the athlete's own result, the leaderboard row and the
 * admin preview. Three copies of this would drift, and the thing they would
 * drift on is the order of the legs — which is the only reason the drawing is
 * worth anything.
 *
 * WHAT IT SHOWS, and why this shape rather than a grid of numbers:
 *
 *   1. Where the time went. Stations and runs are different efforts — one is
 *      work, one is transit — and the split between them is the single most
 *      useful number a HYFIT athlete can be told about their race. A label/value
 *      grid cannot say it at all; three tiles can.
 *   2. The race in order. The circuit is a sequence, so it is drawn as one:
 *      cognitive, then six run/station pairs, top to bottom, with bars on a
 *      shared scale. A long station is visible without reading a single number.
 *   3. Which station cost the most. Comparable only against other STATIONS —
 *      a run and a station are not the same task, and ranking them together
 *      would produce a "slowest leg" that is always a station and means nothing.
 *
 * Colour is decorative here: every bar carries its label and its time, so the
 * chart reads identically in greyscale. Stations are the brand red, runs the
 * teal accent, and the cognitive segment fog — three tokens that already exist
 * in both themes, so nothing here needs a light-mode variant.
 */

import { fmtMs } from "./api";

export type SplitSource = {
    cog_ms: number | null;
    /** Six runs and six stations in course order. Index 0 is Run 1 / Station 1. */
    run_ms: (number | null)[];
    station_ms: (number | null)[];
    total_ms?: number | null;
    penalties?: Record<string, string>;
};

type Leg = {
    key: string;
    label: string;
    short: string;
    ms: number | null;
    kind: "cog" | "run" | "station";
};

const FILL: Record<Leg["kind"], string> = {
    cog: "bg-fog",
    run: "bg-teal",
    station: "bg-hyred",
};

/** Flatten the row into the course order the athlete actually ran. */
function toLegs(source: SplitSource): Leg[] {
    const legs: Leg[] = [
        { key: "cog", label: "Cognitive", short: "COG", ms: source.cog_ms, kind: "cog" },
    ];
    for (let i = 0; i < 6; i++) {
        legs.push({
            key: `run${i + 1}`,
            label: `Run ${i + 1}`,
            short: `RUN ${i + 1}`,
            ms: source.run_ms?.[i] ?? null,
            kind: "run",
        });
        legs.push({
            key: `st${i + 1}`,
            label: `Station ${i + 1}`,
            short: `ST ${i + 1}`,
            ms: source.station_ms?.[i] ?? null,
            kind: "station",
        });
    }
    return legs;
}

const sum = (legs: Leg[]) => legs.reduce((t, l) => t + (l.ms ?? 0), 0);

export default function SplitTimeline({ source }: { source: SplitSource }) {
    const legs = toLegs(source);
    const timed = legs.filter((l) => l.ms !== null);

    // Nothing recorded: say so once rather than drawing thirteen empty bars,
    // which is what a mid-race athlete would otherwise be shown.
    if (!timed.length)
        return (
            <p className="text-xs text-fog">No split times recorded for this entry yet.</p>
        );

    const stations = legs.filter((l) => l.kind === "station" && l.ms !== null);
    const runs = legs.filter((l) => l.kind === "run" && l.ms !== null);
    const stationTotal = sum(stations);
    const runTotal = sum(runs);
    const cog = source.cog_ms ?? 0;

    // The denominator for the tiles. The athlete's own total is preferred —
    // it is what RaceResult scored them on, and it includes whatever the legs
    // do not — falling back to the legs when there is no total yet.
    const accounted = stationTotal + runTotal + cog;
    const total = source.total_ms ?? accounted;

    // Bars share one scale, so a 3:46 station is visibly three times a 1:07
    // run. Scaling each kind separately would draw two charts that look alike
    // and mean different things.
    const longest = Math.max(...timed.map((l) => l.ms as number));

    const slowestStation = stations.length
        ? stations.reduce((a, b) => ((b.ms as number) > (a.ms as number) ? b : a))
        : null;
    const fastestStation =
        stations.length > 1
            ? stations.reduce((a, b) => ((b.ms as number) < (a.ms as number) ? b : a))
            : null;

    const penalties = Object.entries(source.penalties ?? {});

    return (
        <div>
            {/* Where the time went. */}
            <div className="grid grid-cols-3 gap-2">
                <Tile label="Stations" ms={stationTotal} share={stationTotal / total} kind="station" />
                <Tile label="Running" ms={runTotal} share={runTotal / total} kind="run" />
                <Tile label="Cognitive" ms={cog} share={cog / total} kind="cog" />
            </div>

            {/* The three tiles as one bar, so the split between work and
                transit is a proportion and not three percentages to compare in
                your head.

                It was drawn leg by leg first — thirteen segments in course
                order — and at the width of a phone that is a barcode: too fine
                to read, and saying nothing the rows below do not say better. */}
            <div className="mt-2.5 flex h-2 overflow-hidden rounded-full bg-track">
                {(
                    [
                        ['station', stationTotal],
                        ['run', runTotal],
                        ['cog', cog],
                    ] as [Leg['kind'], number][]
                ).map(([kind, ms]) =>
                    ms > 0 ? (
                        <span
                            key={kind}
                            className={FILL[kind]}
                            style={{ width: `${(ms / accounted) * 100}%` }}
                        />
                    ) : null,
                )}
            </div>

            {/* Leg by leg, in course order — and spaced in PAIRS, because that
                is how the circuit is run: a lap is a run to a station and the
                work at it. Six evenly-spaced gaps make six laps countable
                without a single label saying so. */}
            <div className="mt-3">
                {legs.map((leg) => {
                    const missing = leg.ms === null;
                    const width = missing ? 0 : ((leg.ms as number) / longest) * 100;
                    return (
                        <div
                            key={leg.key}
                            className={`flex items-center gap-2.5 ${
                                leg.kind === 'run' ? 'mt-2.5' : 'mt-1'
                            }`}
                        >
                            <span
                                className={`w-14 shrink-0 text-[10px] font-bold uppercase tracking-wider ${
                                    leg.kind === "station" ? "text-chalk" : "text-fog"
                                }`}
                            >
                                {leg.short}
                            </span>
                            <span className="h-2 flex-1 overflow-hidden rounded-full bg-track">
                                {/* A recorded leg always draws something: a 1px
                                    sliver reads as "fast", a bar of zero width
                                    reads as "not recorded", and those are
                                    different facts. */}
                                {!missing && (
                                    <span
                                        className={`block h-2 rounded-full ${FILL[leg.kind]}`}
                                        style={{ width: `${Math.max(width, 2)}%` }}
                                    />
                                )}
                            </span>
                            <span
                                className={`w-12 shrink-0 text-right font-mono text-xs ${
                                    missing ? "text-fog" : "text-chalk"
                                }`}
                            >
                                {missing ? "—" : fmtMs(leg.ms)}
                            </span>
                        </div>
                    );
                })}
            </div>

            {/* Ranked against other stations only. */}
            {slowestStation && (
                <p className="mt-3 text-[11px] text-fog">
                    Longest station <span className="text-chalk">{slowestStation.label}</span>{" "}
                    <span className="font-mono">{fmtMs(slowestStation.ms)}</span>
                    {fastestStation && fastestStation.key !== slowestStation.key && (
                        <>
                            {" · "}quickest <span className="text-chalk">{fastestStation.label}</span>{" "}
                            <span className="font-mono">{fmtMs(fastestStation.ms)}</span>
                        </>
                    )}
                </p>
            )}

            {/* Penalties are a judgement made about the race, not a measurement
                of it, so they sit apart from the timeline rather than inside it. */}
            {penalties.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {penalties.map(([name, value]) => (
                        <span
                            key={name}
                            className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn"
                        >
                            {name} {value}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function Tile({
    label,
    ms,
    share,
    kind,
}: {
    label: string;
    ms: number;
    share: number;
    kind: Leg["kind"];
}) {
    const pct = Number.isFinite(share) ? Math.round(share * 100) : 0;
    return (
        <div className="rounded-lg border border-smoke bg-coal px-2.5 py-2">
            {/* No letter-spacing on this one label, unlike every other kicker
                in the app: a third of a 390px phone leaves ~78px inside the
                tile, and "COGNITIVE" tracked out at 10px does not fit — it
                truncated to "COGNITI…" until the tracking came off. Shortening
                the word instead would have made the three tiles disagree with
                the row labels beneath them. */}
            <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${FILL[kind]}`} />
                <span className="truncate text-[10px] font-bold uppercase text-fog">{label}</span>
            </div>
            <p className="mt-1 font-mono text-base leading-none">{ms ? fmtMs(ms) : "—"}</p>
            {/* The share is what makes the number mean something: 14:06 on
                stations is a different race at 60% than at 40%. */}
            <p className="mt-1 text-[10px] text-fog">{ms ? `${pct}% of race` : "not recorded"}</p>
        </div>
    );
}
