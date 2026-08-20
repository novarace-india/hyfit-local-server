"use client";

/* The Sync screen: running an event at a venue and publishing it from prod.
 *
 * ONE FILE, TWO HALVES. Which half you see is what this server IS — the
 * `HYFIT_NODE_ROLE` in its environment, reported as `role` by GET /admin/sync —
 * and never a choice made here. A console that let an operator pick "we are the
 * local server" would have an afternoon in which prod believed it should be
 * pushing its own results somewhere, and the first symptom would be the public
 * site going quiet. So the role is read-only on this screen, stated at the top,
 * and it decides which panel renders.
 *
 * PROD issues the two URLs for one offline event. LOCAL pastes one of them,
 * pulls the event's whole configuration down, and pushes the standings back.
 *
 * TWO DIRECTIONS, TWO BUTTONS, TWO INTERVALS (093). The pull is prod → local:
 * the event's name, dates, RaceResult wiring, declaration text, check-in window
 * and certificate layouts, all entered once on the console an admin already has
 * open. The push is local → prod: the standings. Each side is the only writer
 * of what it owns, which is what makes both safe to run on a timer.
 *
 * WHAT IS DELIBERATELY NOT HERE: a control that publishes. Pushing puts the
 * standings in prod's database; whether a reader is served them is the Results
 * screen's mode, unchanged and still prod's own decision. A push that could
 * also publish would put an unfinished race in front of athletes the first time
 * somebody tested the connection.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { judgeApi } from "../../../../../lib/api";
import { Spinner, ErrorNote, Chip, Empty } from "../../../../../lib/ui";
import { FieldSignIn, useFieldSession } from "../../../../../lib/field-session";
import EventPicker from "../event-picker";

type Role = "prod" | "local";
type DeliveryMode = "online" | "offline";

type Credential = {
    id: string;
    label: string;
    token_prefix: string;
    scopes: string[];
    expires_at: string;
    revoked_at: string | null;
    last_used_at: string | null;
    last_used_ip: string | null;
    use_count: number;
    created_at: string;
    created_by_name: string | null;
    live: boolean;
};

type Target = {
    base_url: string;
    pull_url: string;
    push_url: string;
    token_prefix: string;
    token_expires_at: string | null;
    enabled: boolean;
    interval_minutes: number;
    pull_interval_minutes: number;
    auto_import_results: boolean;
    results_pushed_at: string | null;
    results_pushed_rows: number | null;
    results_stored_at: string | null;
    results_stored_rows: number | null;
    config_pulled_at: string | null;
    last_attempt_at: string | null;
    last_status: "ok" | "error" | "skipped" | null;
    last_error: string | null;
    last_pull_at: string | null;
    last_pull_status: "ok" | "error" | "skipped" | null;
    last_pull_error: string | null;
    consecutive_failures: number;
};

type Run = {
    id: number;
    kind: "config_pull" | "results" | "results_final";
    trigger_source: "manual" | "schedule";
    status: "ok" | "error" | "skipped";
    rows_sent: number;
    chunks: number;
    bytes_sent: number;
    duration_ms: number | null;
    message: string;
    started_at: string;
};

type State = {
    role: Role;
    roleWasUnrecognised: boolean;
    event: { id: string; name: string; delivery_mode: DeliveryMode; results_mode: string };
    counts: { athletes: number; results: number };
    pushIntervals: number[];
    pullIntervals: number[];
    credentials: Credential[];
    remoteCounts: { athletes: number; results: number };
    target: Target | null;
    runs: Run[];
};

const when = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString() : "never";

const ago = (value: string | null | undefined) => {
    if (!value) return "never";
    const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(value).toLocaleString();
};

const intervalLabel = (minutes: number) =>
    minutes === 0 ? "Manual only" : minutes === 60 ? "Every hour" : `Every ${minutes} min`;

const RUN_LABEL: Record<Run["kind"], string> = {
    config_pull: "Configuration pulled",
    results: "Results → cache",
    results_final: "Results → database",
};

export default function SyncPage() {
    const { id: eventId } = useParams<{ id: string }>();
    const scoped = (path: string) =>
        `${path}${path.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(eventId)}`;
    const { user, ready } = useFieldSession();

    const [state, setState] = useState<State | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [refreshing, setRefreshing] = useState(false);
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");

    /* Refetch WITHOUT blanking the screen.
     *
     * `loading` starts true and is cleared by the first load; it is never set
     * back. That is deliberate and was a bug the first time round: every action
     * here ends in a refetch, and a refetch that re-raised `loading` swapped the
     * whole page for a spinner — which unmounts the panels below and takes their
     * local state with it. The visible symptom was the worst one available: you
     * pressed Issue sync URLs, the credential really was minted, and the URLs
     * you were told to copy "now, because they are not shown again" vanished in
     * the same tick. The auto-refresh had the same effect every twenty seconds.
     *
     * `refreshing` carries the same information without costing anyone the
     * screen. */
    const load = useCallback(async () => {
        setRefreshing(true);
        setErr("");
        try {
            setState(await judgeApi<State>(scoped("/admin/sync")));
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [eventId]);

    useEffect(() => {
        setMsg("");
    }, [eventId]);

    useEffect(() => {
        if (user) void load();
    }, [user, load]);

    // A venue laptop is watched, not driven: the interesting numbers change
    // because a timer moved them, not because anybody clicked. Slow enough not
    // to be a second source of load on the uplink it is reporting about.
    useEffect(() => {
        if (!user) return;
        const timer = setInterval(() => void load(), 20_000);
        return () => clearInterval(timer);
    }, [user, load]);

    const act = async (key: string, fn: () => Promise<string>) => {
        setBusy(key);
        setErr("");
        setMsg("");
        try {
            setMsg(await fn());
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
            void load();
        }
    };

    const setMode = (mode: DeliveryMode) =>
        act("mode", async () => {
            await judgeApi(scoped("/admin/sync/delivery-mode"), {
                method: "PUT",
                body: JSON.stringify({ mode }),
            });
            return mode === "offline"
                ? "This event is now run at a venue and published from here"
                : "This event now runs and publishes in one place";
        });

    if (!ready) return <Spinner />;
    if (!user) return <FieldSignIn what="the Sync screen" />;
    if (loading) return <Spinner />;
    if (!state) return <ErrorNote msg={err || "Could not load the sync state"} />;

    const offline = state.event.delivery_mode === "offline";

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-black uppercase tracking-wide">Sync</h1>
                    <p className="mt-0.5 text-xs text-fog">
                        {state.event.name}
                        {refreshing && <span className="ml-2 text-fog">· refreshing…</span>}
                    </p>
                </div>
                <EventPicker eventId={eventId} segment="sync" />
            </div>

            <RoleBanner state={state} />

            {/* Where this event is run. On prod it is the switch that opens the
                ingest routes; on a venue laptop it is what the pairing needs to
                be true. Both copies exist because each gates its own half. */}
            <div className="rounded-xl border border-smoke bg-coal p-5">
                <h2 className="text-sm font-bold uppercase tracking-wide">Delivery</h2>
                <p className="mt-1 text-xs text-fog">
                    An <strong className="text-chalk">online</strong> event runs and publishes in one place. An{" "}
                    <strong className="text-chalk">offline</strong> event is run on a laptop at the venue, which pulls
                    its setup from prod and pushes the standings back.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                    <ModeButton
                        active={!offline}
                        disabled={busy === "mode"}
                        onClick={() => void setMode("online")}
                        title="Online"
                    />
                    <ModeButton
                        active={offline}
                        disabled={busy === "mode"}
                        onClick={() => void setMode("offline")}
                        title="Offline"
                    />
                </div>
                {!offline && (
                    <p className="mt-3 text-xs text-fog">
                        Nothing below applies until this event is set to offline.
                    </p>
                )}
            </div>

            <ErrorNote msg={err} />
            {msg && (
                <div className="rounded-xl border border-smoke bg-coal p-3 text-sm text-fog">{msg}</div>
            )}

            {!offline ? null : state.role === "prod" ? (
                <ProdPanel state={state} scoped={scoped} onDone={load} />
            ) : (
                <LocalPanel state={state} scoped={scoped} onDone={load} />
            )}

            <RunHistory runs={state.runs} />
        </div>
    );
}

function RoleBanner({ state }: { state: State }) {
    const isProd = state.role === "prod";
    return (
        <div className="rounded-xl border border-smoke bg-coal p-4">
            <div className="flex flex-wrap items-center gap-3">
                <Chip tone={isProd ? "default" : "live"}>{isProd ? "PROD NODE" : "LOCAL NODE"}</Chip>
                <p className="text-xs text-fog">
                    {isProd
                        ? "This server publishes. It issues the sync URLs a venue laptop pastes, and receives what that laptop sends."
                        : "This server runs the race. It pulls its setup from prod and pushes the standings back."}
                </p>
            </div>
            {state.roleWasUnrecognised && (
                <p className="mt-2 text-xs text-hyred-ink">
                    HYFIT_NODE_ROLE holds something this build does not recognise, so it has fallen back to{" "}
                    <strong>prod</strong>. On a venue laptop that looks exactly like a laptop refusing to sync — set it
                    to <code>local</code> and restart.
                </p>
            )}
        </div>
    );
}

function ModeButton({
    active,
    disabled,
    onClick,
    title,
}: {
    active: boolean;
    disabled: boolean;
    onClick: () => void;
    title: string;
}) {
    return (
        <button
            disabled={disabled || active}
            onClick={onClick}
            className={`rounded-lg border px-4 py-2 text-xs font-bold uppercase tracking-widest disabled:opacity-60 ${
                active ? "border-hyred bg-hyred text-onfill" : "border-smoke text-fog hover:text-chalk"
            }`}
        >
            {title}
        </button>
    );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="rounded-lg border border-smoke bg-ink p-3">
            <div className="text-xs font-bold uppercase tracking-widest text-fog">{label}</div>
            <div className="mt-1 text-lg font-black">{value}</div>
            {hint && <div className="mt-0.5 text-xs text-fog">{hint}</div>}
        </div>
    );
}

/* One endpoint, ready to copy.
 *
 * Labelled by DIRECTION rather than by route, because "what the venue reads"
 * and "what the venue sends" is the distinction an operator needs and
 * `/config` vs `/results` is not. Both carry the same credential, so pasting
 * either one into the venue server connects it for both — which is said out
 * loud below, because an operator who believes they need both will go looking
 * for a second box to put one in.
 */
function EndpointField({
    title,
    direction,
    url,
    copied,
    onCopy,
}: {
    title: string;
    direction: string;
    url: string;
    copied: boolean;
    onCopy: () => void;
}) {
    return (
        <div className="rounded-lg border border-smoke bg-ink p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <span className="text-xs font-bold uppercase tracking-widest text-fog">{title}</span>
                    <span className="mt-0.5 block text-xs text-fog">{direction}</span>
                </div>
                <button
                    onClick={onCopy}
                    className="rounded-lg bg-hyred px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-onfill"
                >
                    {copied ? "Copied" : "Copy URL"}
                </button>
            </div>
            <textarea
                readOnly
                value={url}
                rows={2}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-2 w-full break-all rounded-lg border border-smoke bg-coal px-3 py-2 font-mono text-xs outline-none"
            />
        </div>
    );
}

/* -------------------------------------------------------------------- prod */

function ProdPanel({
    state,
    scoped,
    onDone,
}: {
    state: State;
    scoped: (p: string) => string;
    onDone: () => void;
}) {
    const [label, setLabel] = useState("");
    const [hours, setHours] = useState(72);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const [copied, setCopied] = useState("");
    const [issued, setIssued] = useState<{
        pullUrl: string;
        pushUrl: string;
        expiresAt: string;
        baseUrlMissing: boolean;
    } | null>(null);

    const mint = async () => {
        setBusy(true);
        setErr("");
        try {
            const created = await judgeApi<{
                expiresAt: string;
                pullUrl: string;
                pushUrl: string;
                baseUrlMissing: boolean;
            }>(scoped("/admin/sync/credentials"), {
                method: "POST",
                body: JSON.stringify({ label, hours }),
            });
            setIssued(created);
            setLabel("");
            onDone();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (id: string) => {
        setBusy(true);
        setErr("");
        try {
            await judgeApi(scoped(`/admin/sync/credentials/${id}`), { method: "DELETE" });
            onDone();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };

    const copy = async (which: string, url: string) => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(which);
            setTimeout(() => setCopied(""), 2000);
        } catch {
            /* The textarea is selectable; a blocked clipboard is not an error
               worth a red box over. */
        }
    };

    return (
        <div className="space-y-5">
            <div className="rounded-xl border border-smoke bg-coal p-5">
                <h2 className="text-sm font-bold uppercase tracking-wide">What this server holds</h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Stat
                        label="Athletes"
                        value={String(state.remoteCounts?.athletes ?? 0)}
                        hint="Written by the venue's results pushes"
                    />
                    <Stat label="Results" value={String(state.remoteCounts?.results ?? 0)} />
                </div>
            </div>

            <div className="rounded-xl border border-smoke bg-coal p-5">
                <h2 className="text-sm font-bold uppercase tracking-wide">Issue the sync URLs</h2>
                <p className="mt-1 text-xs text-fog">
                    One credential, two endpoints. The venue laptop pastes{" "}
                    <strong className="text-chalk">either one</strong> and gets both.
                </p>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                        <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">
                            Label
                        </label>
                        <input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="Bengaluru laptop"
                            className="w-full rounded-lg border border-smoke bg-ink px-3 py-2.5 text-sm outline-none focus:border-hyred"
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">
                            Valid for (hours)
                        </label>
                        <input
                            type="number"
                            min={1}
                            max={2160}
                            value={hours}
                            onChange={(e) => setHours(Number(e.target.value))}
                            className="w-full rounded-lg border border-smoke bg-ink px-3 py-2.5 text-sm outline-none focus:border-hyred"
                        />
                    </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button
                        disabled={busy}
                        onClick={() => void mint()}
                        className="rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                    >
                        {busy ? "Issuing…" : "Issue sync URLs"}
                    </button>
                    <ErrorNote msg={err} />
                </div>

                {issued && (
                    <div className="mt-4 space-y-3 rounded-lg border border-hyred bg-ink p-4">
                        <p className="text-xs font-bold uppercase tracking-widest text-hyred-ink">
                            Copy one of these now — they are not shown again
                        </p>
                        <p className="text-xs text-fog">
                            The credential in them is stored here only as a hash. If it is lost, issue another; there is
                            no way to read this one back.
                        </p>

                        {issued.baseUrlMissing ? (
                            <p className="text-xs text-hyred-ink">
                                This deployment does not know its own public address, so the URLs could not be built.
                                Set <code>HYFIT_PUBLIC_BASE_URL</code> to the address a venue laptop can reach it on and
                                restart, then issue again.
                            </p>
                        ) : (
                            <>
                                <EndpointField
                                    title="Configuration"
                                    direction="Prod → venue. The event and how it is set up."
                                    url={issued.pullUrl}
                                    copied={copied === "pull"}
                                    onCopy={() => void copy("pull", issued.pullUrl)}
                                />
                                <EndpointField
                                    title="Results"
                                    direction="Venue → prod. The standings."
                                    url={issued.pushUrl}
                                    copied={copied === "push"}
                                    onCopy={() => void copy("push", issued.pushUrl)}
                                />
                                <p className="text-xs text-fog">
                                    Expires {when(issued.expiresAt)}.
                                </p>
                            </>
                        )}
                    </div>
                )}
            </div>

            <div className="rounded-xl border border-smoke bg-coal p-5">
                <h2 className="text-sm font-bold uppercase tracking-wide">Credentials</h2>
                {!state.credentials.length ? (
                    <Empty title="None issued" hint="A venue laptop needs one to reach this event." />
                ) : (
                    <div className="mt-3 space-y-2">
                        {state.credentials.map((c) => (
                            <div
                                key={c.id}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-smoke bg-ink p-3"
                            >
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-bold">{c.label || "Unlabelled"}</span>
                                        <Chip tone={c.live ? "ok" : "default"}>
                                            {c.revoked_at ? "revoked" : c.live ? "live" : "expired"}
                                        </Chip>
                                        <code className="text-xs text-fog">{c.token_prefix}…</code>
                                    </div>
                                    <div className="mt-1 text-xs text-fog">
                                        {c.scopes.join(" + ")} · expires {when(c.expires_at)} · used {c.use_count}×
                                        {c.last_used_at ? ` · last ${ago(c.last_used_at)}` : " · never used"}
                                        {c.last_used_ip ? ` from ${c.last_used_ip}` : ""}
                                    </div>
                                </div>
                                {!c.revoked_at && (
                                    <button
                                        disabled={busy}
                                        onClick={() => void revoke(c.id)}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-fog hover:text-hyred-ink disabled:opacity-40"
                                    >
                                        Revoke
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------- local */

function LocalPanel({
    state,
    scoped,
    onDone,
}: {
    state: State;
    scoped: (p: string) => string;
    onDone: () => void;
}) {
    const target = state.target;
    const [busy, setBusy] = useState("");
    const [err, setErr] = useState("");
    const [msg, setMsg] = useState("");

    const act = async (key: string, fn: () => Promise<string>) => {
        setBusy(key);
        setErr("");
        setMsg("");
        try {
            setMsg(await fn());
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
            onDone();
        }
    };

    if (!target) {
        return (
            <div className="rounded-xl border border-smoke bg-coal p-5">
                <h2 className="text-sm font-bold uppercase tracking-wide">Not paired</h2>
                <p className="mt-1 text-xs text-fog">
                    This event exists on this laptop but is not connected to prod. Events are normally created BY
                    pairing — from the{" "}
                    <Link
                        href="/hyfitgames/admin/events"
                        className="underline underline-offset-4 hover:text-hyred-ink"
                    >
                        Events
                    </Link>{" "}
                    screen, by pasting the sync URL prod issued. An event that got here another way cannot be paired
                    retroactively: prod's event has its own id, and pairing is what makes the two ids the same one.
                </p>
            </div>
        );
    }

    const save = (patch: Record<string, unknown>, note: string) =>
        act("config", async () => {
            await judgeApi(scoped("/admin/sync/config"), {
                method: "PUT",
                body: JSON.stringify(patch),
            });
            return note;
        });

    return (
        <div className="space-y-5">
            {/* ---------------------------------------------- the two buttons */}
            <div className="rounded-xl border border-smoke bg-coal p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-bold uppercase tracking-wide">Sync now</h2>
                        <p className="mt-1 text-xs text-fog">
                            Both directions also run on their own timers below. These are for when you want to know now.
                        </p>
                    </div>
                    <Chip tone={target.enabled ? "live" : "default"}>
                        {target.enabled ? "AUTOMATIC ON" : "PAUSED"}
                    </Chip>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {/* PULL */}
                    <div className="rounded-lg border border-smoke bg-ink p-4">
                        <div className="text-xs font-bold uppercase tracking-widest text-fog">Prod → this laptop</div>
                        <p className="mt-1 text-xs text-fog">
                            The event, its RaceResult wiring, declaration text, check-in window and certificate layouts.
                        </p>
                        <button
                            disabled={Boolean(busy)}
                            onClick={() =>
                                void act("pull", async () => {
                                    const out = await judgeApi<{ status: string; message: string }>(
                                        scoped("/admin/sync/pull"),
                                        { method: "POST", body: JSON.stringify({}) },
                                    );
                                    return out.message || "Configuration pulled";
                                })
                            }
                            className="mt-3 w-full rounded-lg bg-hyred px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                        >
                            {busy === "pull" ? "Pulling…" : "Pull configuration"}
                        </button>
                        <div className="mt-2 text-xs text-fog">
                            Last pull {ago(target.last_pull_at)}
                            {target.last_pull_status ? ` · ${target.last_pull_status}` : ""}
                            {target.config_pulled_at
                                ? ` · last change applied ${ago(target.config_pulled_at)}`
                                : " · nothing applied yet"}
                        </div>
                        {target.last_pull_error && (
                            <p className="mt-1 text-xs text-hyred-ink">{target.last_pull_error}</p>
                        )}
                    </div>

                    {/* PUSH */}
                    <div className="rounded-lg border border-smoke bg-ink p-4">
                        <div className="text-xs font-bold uppercase tracking-widest text-fog">This laptop → prod</div>
                        <p className="mt-1 text-xs text-fog">
                            The standings, into prod&apos;s cache. Every result carries its own athlete, so there is
                            nothing to send first.
                        </p>
                        <button
                            disabled={Boolean(busy)}
                            onClick={() =>
                                void act("push", async () => {
                                    const out = await judgeApi<{ rows: number; message: string }>(
                                        scoped("/admin/sync/push"),
                                        { method: "POST", body: JSON.stringify({ kind: "results" }) },
                                    );
                                    return out.message || `Pushed ${out.rows} result row(s)`;
                                })
                            }
                            className="mt-3 w-full rounded-lg bg-hyred px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                        >
                            {busy === "push" ? "Pushing…" : "Push results"}
                        </button>
                        <div className="mt-2 text-xs text-fog">
                            Last push {ago(target.results_pushed_at)}
                            {target.last_status ? ` · ${target.last_status}` : ""}
                            {typeof target.results_pushed_rows === "number"
                                ? ` · ${target.results_pushed_rows} row(s)`
                                : ""}
                        </div>
                        {target.last_error && <p className="mt-1 text-xs text-hyred-ink">{target.last_error}</p>}
                    </div>
                </div>

                {/* The end-of-day act, kept apart from the two above because it
                    is the one that is not routine: it writes prod's TABLES, so
                    the standings outlive the cache. */}
                <div className="mt-4 rounded-lg border border-smoke bg-ink p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <div className="text-xs font-bold uppercase tracking-widest text-fog">
                                Publish final standings
                            </div>
                            <p className="mt-1 text-xs text-fog">
                                Everything above goes into prod&apos;s cache, which expires. This writes its database,
                                so the history page, the scorecards and the certificates still work tomorrow. Do it once,
                                at the end.
                            </p>
                            <div className="mt-1 text-xs text-fog">
                                Last written {ago(target.results_stored_at)}
                                {typeof target.results_stored_rows === "number"
                                    ? ` · ${target.results_stored_rows} row(s)`
                                    : ""}
                            </div>
                        </div>
                        <button
                            disabled={Boolean(busy)}
                            onClick={() =>
                                void act("final", async () => {
                                    const out = await judgeApi<{ rows: number }>(scoped("/admin/sync/push"), {
                                        method: "POST",
                                        body: JSON.stringify({ kind: "results_final" }),
                                    });
                                    return `${out.rows} row(s) written to prod's database`;
                                })
                            }
                            className="rounded-lg border border-hyred px-4 py-2 text-xs font-bold uppercase tracking-widest text-hyred-ink disabled:opacity-40"
                        >
                            {busy === "final" ? "Writing…" : "Publish final"}
                        </button>
                    </div>
                </div>

                <ErrorNote msg={err} />
                {msg && <p className="mt-3 text-sm text-fog">{msg}</p>}
            </div>

            {/* ------------------------------------------------ what we hold */}
            <div className="rounded-xl border border-smoke bg-coal p-5">
                <h2 className="text-sm font-bold uppercase tracking-wide">On this laptop</h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Stat label="Athletes" value={String(state.counts?.athletes ?? 0)} />
                    <Stat label="Results" value={String(state.counts?.results ?? 0)} hint="What a push would send" />
                </div>
            </div>

            {/* ------------------------------------------------- the schedule */}
            <div className="rounded-xl border border-smoke bg-coal p-5">
                <h2 className="text-sm font-bold uppercase tracking-wide">Automatic sync</h2>
                <p className="mt-1 text-xs text-fog">
                    Two intervals, because the two directions answer to different things: standings change constantly
                    while a race is scored, configuration changes when an admin edits it. Set either to 0 for manual
                    only.
                </p>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <IntervalField
                        title="Pull configuration"
                        value={target.pull_interval_minutes}
                        suggestions={state.pullIntervals}
                        disabled={busy === "config"}
                        onSave={(v) => void save({ pullIntervalMinutes: v }, `Pull interval: ${intervalLabel(v)}`)}
                    />
                    <IntervalField
                        title="Push results"
                        value={target.interval_minutes}
                        suggestions={state.pushIntervals}
                        disabled={busy === "config"}
                        onSave={(v) => void save({ intervalMinutes: v }, `Push interval: ${intervalLabel(v)}`)}
                    />
                </div>

                <div className="mt-4 space-y-3">
                    <Toggle
                        checked={target.enabled}
                        disabled={busy === "config"}
                        onChange={(v) =>
                            void save({ enabled: v }, v ? "Automatic sync resumed" : "Automatic sync paused")
                        }
                        title="Sync automatically"
                        hint="Off pauses both timers without forgetting where prod is."
                    />
                    <Toggle
                        checked={target.auto_import_results}
                        disabled={busy === "config"}
                        onChange={(v) =>
                            void save(
                                { autoImportResults: v },
                                v
                                    ? "Results will be re-imported from RaceResult before each scheduled push"
                                    : "Scheduled pushes will send the standings already stored here",
                            )
                        }
                        title="Re-import from RaceResult before each push"
                        hint="On during a race, off after one: it keeps the stored standings current, which is the wrong thing once they are final."
                    />
                </div>
            </div>

            {/* ------------------------------------------------- where it goes */}
            <div className="rounded-xl border border-smoke bg-coal p-5">
                <h2 className="text-sm font-bold uppercase tracking-wide">Where is it pointed?</h2>
                <p className="mt-1 text-xs text-fog">
                    Paired to <code className="text-chalk">{target.base_url}</code> with credential{" "}
                    <code className="text-chalk">{target.token_prefix}…</code>
                    {target.token_expires_at ? `, expiring ${when(target.token_expires_at)}` : ""}.
                </p>

                <div className="mt-4 space-y-3">
                    <EditableEndpoint
                        title="Server address"
                        hint="Changing this rewrites the origin of both endpoints below and keeps their paths — for when prod moves, or the venue reaches it by another route."
                        value={target.base_url}
                        disabled={busy === "config"}
                        onSave={(v) => void save({ baseUrl: v }, "Server address updated")}
                    />
                    <EditableEndpoint
                        title="Configuration endpoint (GET)"
                        hint="What this laptop reads prod's setup from."
                        value={target.pull_url}
                        disabled={busy === "config"}
                        onSave={(v) => void save({ pullUrl: v }, "Configuration endpoint saved")}
                    />
                    <EditableEndpoint
                        title="Results endpoint (POST)"
                        hint="What this laptop publishes the standings to."
                        value={target.push_url}
                        disabled={busy === "config"}
                        onSave={(v) => void save({ pushUrl: v }, "Results endpoint saved")}
                    />
                </div>

                <div className="mt-4 flex flex-wrap gap-3">
                    <button
                        disabled={Boolean(busy)}
                        onClick={() =>
                            void act("check", async () => {
                                const out = await judgeApi<{ remote: { event: { name: string } } }>(
                                    scoped("/admin/sync/check"),
                                    { method: "POST", body: JSON.stringify({}) },
                                );
                                return `Prod answered for "${out.remote?.event?.name ?? "?"}"`;
                            })
                        }
                        className="rounded-lg border border-smoke px-4 py-2 text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk disabled:opacity-40"
                    >
                        {busy === "check" ? "Checking…" : "Test connection"}
                    </button>
                    <button
                        disabled={Boolean(busy)}
                        onClick={() =>
                            void act("unpair", async () => {
                                await judgeApi(scoped("/admin/sync/pair"), { method: "DELETE" });
                                return "Disconnected. Nothing already published on prod was withdrawn.";
                            })
                        }
                        className="rounded-lg border border-smoke px-4 py-2 text-xs font-bold uppercase tracking-widest text-fog hover:text-hyred-ink disabled:opacity-40"
                    >
                        Disconnect
                    </button>
                </div>
            </div>
        </div>
    );
}

/* An interval box with quick picks beside it.
 *
 * The picks are SUGGESTIONS, not the permitted set: any whole number of minutes
 * up to a day is accepted. An enumerated dropdown answered "every 7 minutes"
 * with a constraint name, which is a real thing a venue asks for. */
function IntervalField({
    title,
    value,
    suggestions,
    disabled,
    onSave,
}: {
    title: string;
    value: number;
    suggestions: number[];
    disabled: boolean;
    onSave: (v: number) => void;
}) {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);
    const parsed = Number(draft);
    const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 1440;

    return (
        <div className="rounded-lg border border-smoke bg-ink p-3">
            <div className="text-xs font-bold uppercase tracking-widest text-fog">{title}</div>
            <div className="mt-2 flex items-center gap-2">
                <input
                    type="number"
                    min={0}
                    max={1440}
                    value={draft}
                    disabled={disabled}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-24 rounded-lg border border-smoke bg-coal px-3 py-2 text-sm outline-none focus:border-hyred"
                />
                <span className="text-xs text-fog">minutes</span>
                <button
                    disabled={disabled || !valid || parsed === value}
                    onClick={() => onSave(parsed)}
                    className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk disabled:opacity-30"
                >
                    Save
                </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
                {suggestions.map((m) => (
                    <button
                        key={m}
                        disabled={disabled}
                        onClick={() => {
                            setDraft(String(m));
                            onSave(m);
                        }}
                        className={`rounded border px-2 py-1 text-xs ${
                            m === value ? "border-hyred text-chalk" : "border-smoke text-fog hover:text-chalk"
                        }`}
                    >
                        {m === 0 ? "Manual" : m}
                    </button>
                ))}
            </div>
            <p className="mt-2 text-xs text-fog">{intervalLabel(value)}</p>
        </div>
    );
}

/* A stored URL, editable in place.
 *
 * The endpoints are stored WHOLE rather than rebuilt from an origin and an
 * event id, which is what makes editing one meaningful — see migration 093.
 * Before that the sender invented the path, the invented one happened to match,
 * and the day it stopped matching there was no screen on which anybody could
 * see it, let alone change it. */
function EditableEndpoint({
    title,
    hint,
    value,
    disabled,
    onSave,
}: {
    title: string;
    hint: string;
    value: string;
    disabled: boolean;
    onSave: (v: string) => void;
}) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const dirty = draft.trim() !== value.trim();

    return (
        <div className="rounded-lg border border-smoke bg-ink p-3">
            <div className="text-xs font-bold uppercase tracking-widest text-fog">{title}</div>
            <p className="mt-0.5 text-xs text-fog">{hint}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                    value={draft}
                    disabled={disabled}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-lg border border-smoke bg-coal px-3 py-2 font-mono text-xs outline-none focus:border-hyred"
                />
                <button
                    disabled={disabled || !dirty || !draft.trim()}
                    onClick={() => onSave(draft.trim())}
                    className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk disabled:opacity-30"
                >
                    Save
                </button>
            </div>
        </div>
    );
}

function Toggle({
    checked,
    disabled,
    onChange,
    title,
    hint,
}: {
    checked: boolean;
    disabled: boolean;
    onChange: (v: boolean) => void;
    title: string;
    hint: string;
}) {
    return (
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-smoke bg-ink p-3">
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                className="mt-0.5 accent-hyred"
            />
            <span className="min-w-0">
                <span className="block text-sm font-bold">{title}</span>
                <span className="mt-0.5 block text-xs text-fog">{hint}</span>
            </span>
        </label>
    );
}

function RunHistory({ runs }: { runs: Run[] }) {
    if (!runs?.length) return null;
    return (
        <div className="rounded-xl border border-smoke bg-coal p-5">
            <h2 className="text-sm font-bold uppercase tracking-wide">Recent activity</h2>
            <p className="mt-1 text-xs text-fog">
                Both directions, newest first. This is the answer to &ldquo;when did we last actually reach prod, and
                what did it say&rdquo; — asked an hour into an event, with somebody saying the site is behind.
            </p>
            <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                    <thead>
                        <tr className="border-b border-smoke text-xs uppercase tracking-widest text-fog">
                            <th className="px-2 py-2 text-left">When</th>
                            <th className="px-2 py-2 text-left">What</th>
                            <th className="px-2 py-2 text-left">Trigger</th>
                            <th className="px-2 py-2 text-left">Status</th>
                            <th className="px-2 py-2 text-right">Rows</th>
                            <th className="px-2 py-2 text-left">Note</th>
                        </tr>
                    </thead>
                    <tbody>
                        {runs.map((r) => (
                            <tr key={r.id} className="border-b border-smoke/50">
                                <td className="whitespace-nowrap px-2 py-2 text-fog">{ago(r.started_at)}</td>
                                <td className="px-2 py-2">{RUN_LABEL[r.kind] ?? r.kind}</td>
                                <td className="px-2 py-2 text-fog">{r.trigger_source}</td>
                                <td className="px-2 py-2">
                                    <Chip
                                        tone={r.status === "ok" ? "ok" : r.status === "error" ? "live" : "default"}
                                    >
                                        {r.status}
                                    </Chip>
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums">{r.rows_sent || "—"}</td>
                                <td className="px-2 py-2 text-fog">{r.message || "—"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
