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
 * PROD mints a connection code for one offline event. LOCAL pastes that code,
 * pushes the roster on request, and pushes the standings on a timer.
 *
 * WHAT IS DELIBERATELY NOT HERE: a control that publishes. Pushing puts the
 * standings in prod's database; whether a reader is served them is the Results
 * screen's mode, unchanged and still prod's own decision. A push that could
 * also publish would put an unfinished race in front of athletes the first time
 * somebody tested the connection.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
    remote_event_id: string;
    remote_event_name: string;
    token_prefix: string;
    token_expires_at: string | null;
    enabled: boolean;
    interval_minutes: number;
    auto_import_results: boolean;
    athletes_pushed_at: string | null;
    athletes_pushed_rows: number | null;
    results_pushed_at: string | null;
    results_pushed_rows: number | null;
    last_attempt_at: string | null;
    last_status: "ok" | "error" | "skipped" | null;
    last_error: string | null;
    consecutive_failures: number;
};

type Run = {
    id: number;
    kind: "athletes" | "results";
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
    intervals: number[];
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

/* Read a pasted connection code well enough to show what it points at.
 *
 * The backend decodes it again and is the authority — this is purely so the
 * operator can SEE the server address and the event name before pressing
 * Connect, and correct the address if the venue reaches prod by another route.
 * A code that will not decode here simply shows nothing; it is not rejected,
 * because the backend's message is the better one. */
function peekCode(raw: string): { baseUrl: string; eventName: string; expiresAt: string } | null {
    const compact = String(raw ?? "").replace(/\s+/g, "");
    if (!compact.startsWith("HYFITSYNC1.")) return null;
    try {
        const b64 = compact.slice("HYFITSYNC1.".length).replace(/-/g, "+").replace(/_/g, "/");
        const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
        const d = JSON.parse(new TextDecoder().decode(bytes));
        return {
            baseUrl: String(d.baseUrl ?? ""),
            eventName: String(d.eventName ?? ""),
            expiresAt: String(d.expiresAt ?? ""),
        };
    } catch {
        return null;
    }
}

/* base64url of UTF-8, matching `encodeSyncCredential` on the backend.
 *
 * Through TextEncoder rather than straight into btoa, because btoa throws on
 * any character above U+00FF and an event name is free text — "Bengaluru
 * ಓಟ 2026" would take down the one button on this screen that has to work. */
const base64url = (value: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(value)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

export default function SyncPage() {
    const { id: eventId } = useParams<{ id: string }>();
    const scoped = (path: string) =>
        `${path}${path.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(eventId)}`;
    const { user, ready } = useFieldSession();

    const [state, setState] = useState<State | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        setErr("");
        try {
            setState(await judgeApi<State>(scoped("/admin/sync")));
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setLoading(false);
        }
    }, [eventId]);

    useEffect(() => {
        setMsg("");
    }, [eventId]);

    useEffect(() => {
        if (user) void load();
        else if (ready) setLoading(false);
    }, [user, ready, load]);

    // A push in flight on the server does not tell this page when it lands, and
    // an operator watching an event go up should not have to press reload to
    // find out whether it did. Only while the screen is open, and only on a
    // bound local node — a prod console has nothing that changes on its own.
    useEffect(() => {
        if (!state || state.role !== "local" || !state.target?.enabled) return;
        if (state.target.interval_minutes === 0) return;
        const timer = setInterval(() => void load(), 20_000);
        return () => clearInterval(timer);
    }, [state, load]);

    const flash = (text: string) => {
        setMsg(text);
        setTimeout(() => setMsg(""), 4000);
    };

    const act = async (key: string, fn: () => Promise<string>) => {
        setBusy(key);
        setErr("");
        try {
            flash(await fn());
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy("");
        }
    };

    const setDeliveryMode = (mode: DeliveryMode) =>
        act("mode", async () => {
            await judgeApi(scoped("/admin/sync/delivery-mode"), {
                method: "PUT",
                body: JSON.stringify({ mode }),
            });
            return mode === "offline"
                ? "This event now runs on a local server and publishes from prod"
                : "This event publishes from wherever it runs";
        });

    if (!ready || (loading && user)) return <Spinner />;

    if (!user) {
        return (
            <div>
                <h1 className="text-2xl font-black uppercase tracking-wide">Sync</h1>
                <p className="mt-1 text-sm text-fog">Offline events: the venue and prod</p>
                <FieldSignIn what="event sync" />
            </div>
        );
    }

    const offline = state?.event.delivery_mode === "offline";

    return (
        <div>
            <Link
                href="/hyfitgames/admin/events"
                className="text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk"
            >
                ← All events
            </Link>
            <h1 className="mt-2 text-2xl font-black uppercase tracking-wide">Sync</h1>
            <p className="mt-1 text-sm text-fog">
                Run this event on a local server at the venue, and publish it from prod
            </p>
            <EventPicker eventId={eventId} segment="sync" />

            {msg && <div className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">{msg}</div>}
            <ErrorNote msg={err} />

            {state && (
                <>
                    <RoleBanner state={state} />

                    {/* ------------------------------------------- delivery mode */}
                    <section className="mt-6 rounded-xl border border-smoke bg-coal p-4">
                        <h2 className="text-sm font-bold uppercase tracking-wide">Where this event publishes</h2>
                        <p className="mt-1 text-xs text-fog">
                            Set on both servers. Prod&apos;s copy is what lets a push in at all; the local copy is what
                            turns this screen&apos;s push panel on. Setting only one gives a clear refusal from the other.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <ModeButton
                                active={!offline}
                                disabled={busy === "mode"}
                                onClick={() => void setDeliveryMode("online")}
                                title="Online"
                                body="Whichever deployment runs the event also publishes it. Nothing to sync."
                            />
                            <ModeButton
                                active={!!offline}
                                disabled={busy === "mode"}
                                onClick={() => void setDeliveryMode("offline")}
                                title="Offline"
                                body="A local server runs the event; athletes and results are pushed to prod."
                            />
                        </div>
                    </section>

                    {!offline ? (
                        <div className="mt-4 rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm text-fog">
                            This is an online event. Nothing on this screen applies to it — it publishes from wherever it
                            runs, through the Results screen&apos;s mode, exactly as before.
                        </div>
                    ) : state.role === "prod" ? (
                        <ProdPanel state={state} scoped={scoped} busy={busy} act={act} reload={load} />
                    ) : (
                        <LocalPanel state={state} scoped={scoped} busy={busy} act={act} />
                    )}
                </>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ shared */

function RoleBanner({ state }: { state: State }) {
    const isProd = state.role === "prod";
    return (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm">
            <span className="text-xs font-bold uppercase tracking-widest text-fog">This server</span>
            <Chip tone={isProd ? "live" : "ok"}>{isProd ? "Prod — receives" : "Local — sends"}</Chip>
            <span className="text-fog">
                {isProd
                    ? "It issues connection codes and accepts pushes. It never pushes anywhere itself."
                    : "It pushes this event's athletes and results up to prod. It accepts no pushes."}
            </span>
            {/* HYFIT_NODE_ROLE holding something unrecognised falls back to prod,
                which on a venue laptop looks exactly like a laptop refusing to
                push. Say so rather than letting somebody debug the network. */}
            {state.roleWasUnrecognised && (
                <span className="text-bad">
                    HYFIT_NODE_ROLE was not understood and defaulted to prod — set it to `local` or `prod`.
                </span>
            )}
        </div>
    );
}

function ModeButton({
    active,
    disabled,
    onClick,
    title,
    body,
}: {
    active: boolean;
    disabled: boolean;
    onClick: () => void;
    title: string;
    body: string;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled || active}
            className={`min-w-64 flex-1 rounded-lg border px-3 py-2.5 text-left transition disabled:cursor-default ${
                active ? "border-hyred bg-hyred/10" : "border-smoke hover:border-fog"
            }`}
        >
            <span className="text-sm font-bold uppercase tracking-wide">
                {title} {active && <span className="text-hyred-ink">· current</span>}
            </span>
            <span className="mt-1 block text-xs text-fog">{body}</span>
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

/* -------------------------------------------------------------------- prod */

function ProdPanel({
    state,
    scoped,
    busy,
    act,
    reload,
}: {
    state: State;
    scoped: (path: string) => string;
    busy: string;
    act: (key: string, fn: () => Promise<string>) => Promise<void>;
    reload: () => Promise<void>;
}) {
    const [label, setLabel] = useState("");
    const [hours, setHours] = useState(72);
    const [baseUrl, setBaseUrl] = useState("");
    // The minted secret, held for exactly as long as this page is open. It is
    // not in the state fetched above and cannot be — only its hash was stored —
    // so navigating away is the same as losing it, and the panel says so.
    const [code, setCode] = useState("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (typeof window !== "undefined") setBaseUrl(window.location.origin);
    }, []);

    const mint = () =>
        act("mint", async () => {
            const created = await judgeApi<{
                credential: { eventId: string; eventName: string; token: string; expiresAt: string };
            }>(scoped("/admin/sync/credentials"), {
                method: "POST",
                body: JSON.stringify({ label, hours }),
            });
            // The code is assembled here because prod does not reliably know the
            // address a venue can actually reach it on — behind a load balancer
            // it sees an internal host. The browser that is already talking to
            // it does know, and the field stays editable for a tunnel or an IP.
            setCode(
                "HYFITSYNC1." +
                    base64url(
                        JSON.stringify({
                            baseUrl: baseUrl.replace(/\/+$/, ""),
                            eventId: created.credential.eventId,
                            eventName: created.credential.eventName,
                            token: created.credential.token,
                            expiresAt: created.credential.expiresAt,
                        }),
                    ),
            );
            setCopied(false);
            setLabel("");
            return "Connection code created — copy it now, it is not shown again";
        });

    const revoke = (id: string, name: string) =>
        act(`revoke:${id}`, async () => {
            await judgeApi(scoped(`/admin/sync/credentials/${id}`), { method: "DELETE" });
            return `${name} revoked — the next push from it will be refused`;
        });

    return (
        <>
            <section className="mt-4 grid gap-3 sm:grid-cols-3">
                <Stat label="Athletes here" value={String(state.remoteCounts?.athletes ?? 0)} hint="Pushed from the venue" />
                <Stat label="Results here" value={String(state.remoteCounts?.results ?? 0)} hint="Pushed from the venue" />
                <Stat
                    label="Published"
                    value={state.event.results_mode === "off" ? "Nothing" : state.event.results_mode}
                    hint="Set on the Results screen"
                />
            </section>

            {/* A push fills the tables; it does not decide what a reader is
                served. Say where that switch is rather than duplicating it. */}
            {state.event.results_mode === "off" && (state.remoteCounts?.results ?? 0) > 0 && (
                <div className="mt-3 rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm text-fog">
                    {state.remoteCounts.results} result rows have arrived but nothing is published yet. Set this
                    event&apos;s mode to <span className="font-bold text-chalk">stored</span> on{" "}
                    <Link
                        href={`/hyfitgames/admin/events/${state.event.id}/results`}
                        className="font-bold text-chalk underline"
                    >
                        Results
                    </Link>{" "}
                    when you want athletes to see them.
                </div>
            )}

            <section className="mt-6 rounded-xl border border-smoke bg-coal p-4">
                <h2 className="text-sm font-bold uppercase tracking-wide">Issue a connection code</h2>
                <p className="mt-1 text-xs text-fog">
                    One code, one event, two routes — the roster and the standings. It cannot reach staff, PINs,
                    check-in or the RaceResult endpoints. Carry it to the venue and paste it into the local
                    server&apos;s Sync screen.
                </p>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <label className="text-xs">
                        <span className="font-bold uppercase tracking-widest text-fog">Which machine</span>
                        <input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="Bengaluru laptop"
                            className="mt-1 w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                        />
                    </label>
                    <label className="text-xs">
                        <span className="font-bold uppercase tracking-widest text-fog">Valid for</span>
                        <select
                            value={hours}
                            onChange={(e) => setHours(Number(e.target.value))}
                            className="mt-1 w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                        >
                            {[12, 24, 48, 72, 168].map((h) => (
                                <option key={h} value={h}>
                                    {h < 24 ? `${h} hours` : `${h / 24} day${h === 24 ? "" : "s"}`}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="text-xs">
                        <span className="font-bold uppercase tracking-widest text-fog">Address the venue reaches</span>
                        <input
                            value={baseUrl}
                            onChange={(e) => setBaseUrl(e.target.value)}
                            placeholder="https://app.example.com"
                            className="mt-1 w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                        />
                    </label>
                </div>

                <button
                    onClick={() => void mint()}
                    disabled={!!busy || !baseUrl.trim()}
                    className="mt-3 rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                >
                    {busy === "mint" ? "Creating…" : "Create connection code"}
                </button>

                {code && (
                    <div className="mt-4 rounded-lg border border-hyred bg-hyred/10 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-bold uppercase tracking-widest text-hyred-ink">
                                Copy this now — it is not stored and cannot be shown again
                            </span>
                            <button
                                onClick={() => {
                                    void navigator.clipboard?.writeText(code);
                                    setCopied(true);
                                }}
                                className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk"
                            >
                                {copied ? "Copied" : "Copy"}
                            </button>
                        </div>
                        <textarea
                            readOnly
                            value={code}
                            rows={4}
                            onFocus={(e) => e.currentTarget.select()}
                            className="mt-2 w-full break-all rounded-lg border border-smoke bg-ink px-3 py-2 font-mono text-xs outline-none"
                        />
                    </div>
                )}
            </section>

            <section className="mt-6">
                <h2 className="text-sm font-bold uppercase tracking-wide">Codes for this event</h2>
                {!state.credentials.length ? (
                    <Empty title="No connection codes yet" hint="Create one above and carry it to the venue" />
                ) : (
                    <div className="mt-3 space-y-2">
                        {state.credentials.map((c) => (
                            <div key={c.id} className="rounded-xl border border-smoke bg-coal p-3">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="font-bold">{c.label || "Unlabelled"}</span>
                                            {c.live ? (
                                                <Chip tone="live">Live</Chip>
                                            ) : c.revoked_at ? (
                                                <Chip>Revoked</Chip>
                                            ) : (
                                                <Chip>Expired</Chip>
                                            )}
                                            {c.scopes.map((s) => (
                                                <Chip key={s}>{s}</Chip>
                                            ))}
                                        </div>
                                        <p className="mt-1 font-mono text-xs text-fog">{c.token_prefix}…</p>
                                        <p className="mt-1 text-xs text-fog">
                                            Expires {when(c.expires_at)} · used {c.use_count} time
                                            {c.use_count === 1 ? "" : "s"} · last {ago(c.last_used_at)}
                                            {c.last_used_ip ? ` from ${c.last_used_ip}` : ""}
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => void revoke(c.id, c.label || "That code")}
                                        disabled={!c.live || !!busy}
                                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                                    >
                                        {busy === `revoke:${c.id}` ? "Revoking…" : "Revoke"}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </>
    );
}

/* ------------------------------------------------------------------- local */

function LocalPanel({
    state,
    scoped,
    busy,
    act,
}: {
    state: State;
    scoped: (path: string) => string;
    busy: string;
    act: (key: string, fn: () => Promise<string>) => Promise<void>;
}) {
    const [code, setCode] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    // Changing where an already-bound event pushes, without re-pasting a code:
    // a tunnel restarting on a new host is not a reason to go back to whoever
    // holds the prod console for a fresh credential.
    const [editingUrl, setEditingUrl] = useState(false);
    const [urlDraft, setUrlDraft] = useState("");
    const target = state.target;

    const bind = () =>
        act("bind", async () => {
            const bound = await judgeApi<{ remote: { event: { name: string } } }>(scoped("/admin/sync/bind"), {
                method: "POST",
                body: JSON.stringify({ code, baseUrl: baseUrl.trim() || undefined }),
            });
            setCode("");
            return `Connected to "${bound.remote.event.name}" on prod`;
        });

    const unbind = () =>
        act("unbind", async () => {
            await judgeApi(scoped("/admin/sync/bind"), { method: "DELETE" });
            return "Disconnected — nothing already pushed was withdrawn";
        });

    const check = () =>
        act("check", async () => {
            const seen = await judgeApi<{ remote: { event: { name: string }; counts: { athletes: number; results: number } } }>(
                scoped("/admin/sync/check"),
                { method: "POST" },
            );
            return `Prod answered for "${seen.remote.event.name}" — it holds ${seen.remote.counts.athletes} athletes and ${seen.remote.counts.results} results`;
        });

    const push = (kind: "athletes" | "results") =>
        act(`push:${kind}`, async () => {
            const done = await judgeApi<{ status: string; rows: number; chunks: number; durationMs: number }>(
                scoped("/admin/sync/push"),
                { method: "POST", body: JSON.stringify({ kind }) },
            );
            return `${done.rows} ${kind === "athletes" ? "athlete" : "result"} row(s) pushed in ${done.chunks} request(s), ${done.durationMs}ms`;
        });

    const configure = (patch: {
        intervalMinutes?: number;
        enabled?: boolean;
        autoImportResults?: boolean;
        baseUrl?: string;
    }) =>
        act("configure", async () => {
            await judgeApi(scoped("/admin/sync/config"), { method: "PUT", body: JSON.stringify(patch) });
            if (patch.baseUrl !== undefined) return `Now pushing to ${patch.baseUrl}`;
            if (patch.enabled !== undefined)
                return patch.enabled ? "Automatic pushes resumed" : "Automatic pushes paused";
            if (patch.autoImportResults !== undefined)
                return patch.autoImportResults
                    ? "Standings will be re-imported from RaceResult before each scheduled push"
                    : "Only what you import by hand will be pushed";
            return patch.intervalMinutes === 0
                ? "Results will now be pushed only when you press Push results"
                : `Results will be pushed every ${patch.intervalMinutes} minutes`;
        });

    if (!target) {
        const peek = peekCode(code);
        // The address the code carries, unless the operator has typed over it.
        const effectiveUrl = baseUrl.trim() || peek?.baseUrl || "";

        return (
            <section className="mt-6 rounded-xl border border-smoke bg-coal p-4">
                <h2 className="text-sm font-bold uppercase tracking-wide">Connect to prod</h2>
                <p className="mt-1 text-xs text-fog">
                    Paste the connection code from prod&apos;s Sync screen for the matching event, and check the server
                    address it is pointing at. Nothing is stored until prod confirms which event the code opens.
                </p>

                <label className="mt-3 block text-xs">
                    <span className="font-bold uppercase tracking-widest text-fog">1 · Connection code</span>
                    <textarea
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        rows={4}
                        placeholder="HYFITSYNC1.…"
                        className="mt-1 w-full break-all rounded-lg border border-smoke bg-ink px-3 py-2 font-mono text-xs outline-none focus:border-hyred"
                    />
                </label>

                {/* Not an "override" any more: the address prod is reachable on is
                    a thing the venue operator owns. The code fills it in, and the
                    field stays editable because the address prod knows about
                    itself and the address the venue can reach are routinely
                    different — a load balancer, a tunnel, a LAN IP. */}
                <label className="mt-3 block text-xs">
                    <span className="font-bold uppercase tracking-widest text-fog">2 · Prod server address</span>
                    <input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={peek?.baseUrl || "https://app.example.com"}
                        className="mt-1 w-full rounded-lg border border-smoke bg-ink px-3 py-2 font-mono text-sm outline-none focus:border-hyred"
                    />
                    <span className="mt-1 block text-fog">
                        {peek?.baseUrl && !baseUrl.trim()
                            ? `Taken from the code. Leave it as it is unless this venue reaches prod another way.`
                            : "The origin only — no path. This server must be able to reach it."}
                    </span>
                </label>

                {peek && (
                    <div className="mt-3 rounded-lg border border-smoke bg-ink p-3 text-xs">
                        <span className="font-bold uppercase tracking-widest text-fog">This code says</span>
                        <p className="mt-1 text-chalk">
                            {peek.eventName || "an unnamed event"}
                            {peek.expiresAt ? ` · expires ${when(peek.expiresAt)}` : ""}
                        </p>
                        <p className="mt-1 break-all font-mono text-fog">
                            {effectiveUrl}/api/hyfit-judge/ingest/events/…/athletes
                        </p>
                        <p className="mt-1 text-fog">
                            Prod will confirm the event name when you press Connect. Check it matches the race in front
                            of you.
                        </p>
                    </div>
                )}

                <button
                    onClick={() => void bind()}
                    disabled={!!busy || !code.trim()}
                    className="mt-3 rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                >
                    {busy === "bind" ? "Checking with prod…" : "Connect"}
                </button>
            </section>
        );
    }

    const failing = (target.consecutive_failures ?? 0) > 0;

    return (
        <>
            <section className="mt-6 rounded-xl border border-smoke bg-coal p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-bold uppercase tracking-wide">
                            Connected to {target.remote_event_name || "prod"}
                        </h2>
                        {/* The two URLs this server will actually call, spelled
                            out. "Where is it pushing?" is asked whenever a push
                            fails, and a base URL plus an event id leaves the
                            operator assembling it in their head. */}
                        <p className="mt-1 break-all font-mono text-xs text-fog">
                            {target.base_url}/api/hyfit-judge/ingest/events/{target.remote_event_id}/
                            <span className="text-chalk">{"{athletes,results}"}</span>
                        </p>
                        <p className="mt-0.5 font-mono text-xs text-fog">
                            {target.token_prefix}… · expires {when(target.token_expires_at)}
                        </p>
                        {editingUrl ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <input
                                    value={urlDraft}
                                    onChange={(e) => setUrlDraft(e.target.value)}
                                    placeholder="https://app.example.com"
                                    className="min-w-64 flex-1 rounded-lg border border-smoke bg-ink px-3 py-1.5 font-mono text-xs outline-none focus:border-hyred"
                                />
                                <button
                                    onClick={async () => {
                                        await configure({ baseUrl: urlDraft });
                                        setEditingUrl(false);
                                    }}
                                    disabled={!!busy || !urlDraft.trim()}
                                    className="rounded-lg bg-hyred px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                                >
                                    Save
                                </button>
                                <button
                                    onClick={() => setEditingUrl(false)}
                                    className="text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk"
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={() => {
                                    setUrlDraft(target.base_url);
                                    setEditingUrl(true);
                                }}
                                className="mt-1 text-xs font-bold uppercase tracking-widest text-fog underline hover:text-chalk"
                            >
                                Change server address
                            </button>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            onClick={() => void check()}
                            disabled={!!busy}
                            className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                        >
                            {busy === "check" ? "Asking prod…" : "Test connection"}
                        </button>
                        <button
                            onClick={() => void unbind()}
                            disabled={!!busy}
                            className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                        >
                            Disconnect
                        </button>
                    </div>
                </div>

                {/* The line an operator actually looks at mid-event. */}
                <div
                    className={`mt-3 rounded-lg px-3 py-2 text-sm ${
                        failing ? "bg-bad-soft text-bad" : "bg-good-soft text-good"
                    }`}
                >
                    {failing
                        ? `Last ${target.consecutive_failures} attempt(s) failed — ${target.last_error || "no reason given"}`
                        : `Last attempt ${ago(target.last_attempt_at)} · ${target.last_status ?? "nothing sent yet"}`}
                </div>
            </section>

            {/* ------------------------------------------------------- roster */}
            <section className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-smoke bg-coal p-4">
                    <h3 className="text-sm font-bold uppercase tracking-wide">Athletes</h3>
                    <p className="mt-1 text-xs text-fog">
                        {state.counts.athletes} on this server&apos;s start list · last pushed{" "}
                        {ago(target.athletes_pushed_at)}
                        {target.athletes_pushed_rows != null ? ` (${target.athletes_pushed_rows} rows)` : ""}
                    </p>
                    <p className="mt-2 text-xs text-fog">
                        Sent whole, and prod drops whoever this push did not bring — so a withdrawal here is a
                        withdrawal there. Push it after every roster import; results cannot land for athletes prod has
                        never heard of.
                    </p>
                    <button
                        onClick={() => void push("athletes")}
                        disabled={!!busy}
                        className="mt-3 w-full rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                    >
                        {busy === "push:athletes" ? "Pushing…" : "Sync athletes to prod"}
                    </button>
                </div>

                <div className="rounded-xl border border-smoke bg-coal p-4">
                    <h3 className="text-sm font-bold uppercase tracking-wide">Results</h3>
                    <p className="mt-1 text-xs text-fog">
                        {state.counts.results} stored on this server · last pushed {ago(target.results_pushed_at)}
                        {target.results_pushed_rows != null ? ` (${target.results_pushed_rows} rows)` : ""}
                    </p>

                    <label className="mt-3 block text-xs">
                        <span className="font-bold uppercase tracking-widest text-fog">Push automatically</span>
                        <select
                            value={target.interval_minutes}
                            disabled={!!busy}
                            onChange={(e) => void configure({ intervalMinutes: Number(e.target.value) })}
                            className="mt-1 w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                        >
                            {state.intervals.map((m) => (
                                <option key={m} value={m}>
                                    {intervalLabel(m)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className="mt-1 text-xs text-fog">
                        The timer runs on this server, not in this browser — closing the console does not stop it. A
                        scheduled push that would send standings prod already has is skipped.
                    </p>

                    {/* Without this the timer re-sends the same stored snapshot
                        all afternoon: the Results screen's Import is the only
                        thing that writes this server's standings. Off by
                        default, because keeping stored results current is right
                        during a race and wrong after one. */}
                    <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-smoke p-3 text-xs">
                        <input
                            type="checkbox"
                            checked={target.auto_import_results}
                            disabled={!!busy}
                            onChange={(e) => void configure({ autoImportResults: e.target.checked })}
                            className="mt-0.5 accent-hyred"
                        />
                        <span>
                            <span className="font-bold uppercase tracking-widest text-fog">
                                Re-import from RaceResult first
                            </span>
                            <span className="mt-1 block text-fog">
                                Each scheduled push pulls the standings into this server before sending them. Leave it
                                off and the timer only sends what you last imported by hand on the Results screen. If
                                RaceResult cannot be reached, the push still sends what is stored here and says so.
                            </span>
                        </span>
                    </label>

                    <div className="mt-3 flex flex-wrap gap-2">
                        <button
                            onClick={() => void push("results")}
                            disabled={!!busy}
                            className="flex-1 rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                        >
                            {busy === "push:results" ? "Pushing…" : "Push results now"}
                        </button>
                        <button
                            onClick={() => void configure({ enabled: !target.enabled })}
                            disabled={!!busy}
                            className="rounded-lg border border-smoke px-3 py-2 text-xs font-bold uppercase tracking-wide text-fog hover:text-chalk disabled:opacity-40"
                        >
                            {target.enabled ? "Pause" : "Resume"}
                        </button>
                    </div>
                </div>
            </section>

            <RunHistory runs={state.runs} />
        </>
    );
}

function RunHistory({ runs }: { runs: Run[] }) {
    const tone = useMemo(
        () => ({ ok: "text-good", error: "text-bad", skipped: "text-fog" }) as Record<string, string>,
        [],
    );

    return (
        <section className="mt-6">
            <h2 className="text-sm font-bold uppercase tracking-wide">Recent pushes</h2>
            <p className="mt-1 text-xs text-fog">
                Kept on this server. The question this answers is asked an hour into an event, with somebody saying the
                public site is behind.
            </p>
            {!runs?.length ? (
                <Empty title="Nothing pushed yet" hint="Sync the athletes first, then the results follow" />
            ) : (
                <div className="mt-3 overflow-x-auto rounded-xl border border-smoke">
                    <table className="w-full min-w-[40rem] text-left text-sm">
                        <thead className="bg-coal text-xs uppercase tracking-widest text-fog">
                            <tr>
                                <th className="px-3 py-2">When</th>
                                <th className="px-3 py-2">What</th>
                                <th className="px-3 py-2">Result</th>
                                <th className="px-3 py-2">Rows</th>
                                <th className="px-3 py-2">Took</th>
                                <th className="px-3 py-2">Note</th>
                            </tr>
                        </thead>
                        <tbody>
                            {runs.map((r) => (
                                <tr key={r.id} className="border-t border-smoke">
                                    <td className="whitespace-nowrap px-3 py-2 text-fog">{ago(r.started_at)}</td>
                                    <td className="px-3 py-2">
                                        {r.kind} <span className="text-xs text-fog">· {r.trigger_source}</span>
                                    </td>
                                    <td className={`px-3 py-2 font-bold ${tone[r.status] ?? ""}`}>{r.status}</td>
                                    <td className="px-3 py-2 text-fog">
                                        {r.rows_sent}
                                        {r.chunks ? <span className="text-xs"> / {r.chunks} req</span> : null}
                                    </td>
                                    <td className="px-3 py-2 text-fog">
                                        {r.duration_ms != null ? `${r.duration_ms}ms` : "—"}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-fog">{r.message || "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
