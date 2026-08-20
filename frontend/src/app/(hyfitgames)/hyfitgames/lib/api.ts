/* HYFIT Games API client (ported from the module's src/api.js).
 *
 * Two differences from the standalone original, because this now runs inside
 * the Novarace NestJS backend:
 *   1. Base path is `/api/hyfitgames` (same-origin; Next rewrites /api/* to
 *      the backend), instead of the module's own `/api`.
 *   2. The Novarace backend wraps every response in a standard envelope
 *      ({ statusCode, status, data } on success; { statusCode, status, message }
 *      on error, returned with HTTP 200 for 4xx). So success unwraps `.data`,
 *      errors read `.message`, and a token refresh is triggered by
 *      body.statusCode === 401 rather than the HTTP status.
 *
 * Auth stays bearer-token based (localStorage), matching the module. */

import { ATHLETE_LOGIN_ENABLED, PUBLIC_HOME } from "./flags";

const BASE = "/api/hyfitgames";

export function appPath(path: string): string {
    if (typeof window === "undefined") return path;
    const isStandalone = !window.location.pathname.startsWith("/hyfitgames");
    if (isStandalone) {
        const stripped = path.replace(/^\/hyfitgames/, "");
        return stripped === "" ? "/" : stripped;
    }
    return path;
}

type Role = "athlete" | "admin";

const makeStore = (prefix: string) => ({
    get access() {
        return typeof window !== "undefined" ? localStorage.getItem(`${prefix}_at`) : null;
    },
    get refresh() {
        return typeof window !== "undefined" ? localStorage.getItem(`${prefix}_rt`) : null;
    },
    set({ accessToken, refreshToken }: { accessToken?: string; refreshToken?: string }) {
        if (accessToken) localStorage.setItem(`${prefix}_at`, accessToken);
        if (refreshToken) localStorage.setItem(`${prefix}_rt`, refreshToken);
    },
    clear() {
        localStorage.removeItem(`${prefix}_at`);
        localStorage.removeItem(`${prefix}_rt`);
    },
});

const athleteStore = makeStore("hyfit");
const adminStore = makeStore("hyfit_admin");

let refreshing: Promise<void> | null = null;

async function refreshTokens(role: Role = "athlete") {
    const store = role === "admin" ? adminStore : athleteStore;
    refreshing ??= (async () => {
        const res = await fetch(`${BASE}/auth/refresh`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: store.refresh }),
        });
        const body = await res.json().catch(() => null);
        const data = unwrap(body);
        if (!res.ok || !data?.accessToken) {
            store.clear();
            throw new Error("expired");
        }
        store.set(data);
    })().finally(() => {
        refreshing = null;
    });
    return refreshing;
}

// Pull the payload out of the Novarace success envelope; leave bare payloads
// (already-unwrapped or non-enveloped) untouched.
function unwrap(body: any): any {
    if (body && typeof body === "object" && "data" in body && "statusCode" in body) {
        return body.data;
    }
    return body;
}

interface ApiOptions {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    raw?: boolean;
    role?: Role;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}, isRetry = false): Promise<T> {
    const { method = "GET", body, raw = false, role = "athlete" } = opts;
    const store = role === "admin" ? adminStore : athleteStore;

    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            ...(store.access ? { Authorization: `Bearer ${store.access}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    // Raw mode (e.g. certificate PDF download): hand back the Response as-is.
    if (raw) return res as unknown as T;

    const parsed = await res.json().catch(() => null);
    const statusCode: number | undefined = parsed?.statusCode;

    // The backend returns HTTP 200 with body.statusCode === 401 when the access
    // token has expired. Refresh once and retry.
    if (statusCode === 401 && store.refresh && !isRetry) {
        try {
            await refreshTokens(role);
            return api<T>(path, opts, true);
        } catch {
            store.clear();
            if (typeof window !== "undefined") {
                // An athlete is sent to the login screen only while there IS
                // one. With athlete login off (lib/flags.ts) that screen just
                // forwards here anyway, and bouncing through it turns an
                // expired token into a visible flicker on a public page.
                const athleteDestination = ATHLETE_LOGIN_ENABLED ? "/hyfitgames/login" : PUBLIC_HOME;
                window.location.href = appPath(role === "admin" ? "/hyfitgames/admin/login" : athleteDestination);
            }
            throw new Error("Session expired");
        }
    }

    const failed = parsed?.status === "failure" || (typeof statusCode === "number" && statusCode >= 400) || !res.ok;
    if (failed) throw new Error(parsed?.message || "Something went wrong");

    return unwrap(parsed) as T;
}

export const session = {
    isLoggedIn: () => !!athleteStore.access,
    save: (tokens: { accessToken?: string; refreshToken?: string }) => athleteStore.set(tokens),
    logout: async () => {
        try {
            await api("/auth/logout", { method: "POST", body: { refreshToken: athleteStore.refresh } });
        } catch {
            /* best effort */
        }
        athleteStore.clear();
    },
};

export const adminSession = {
    isLoggedIn: () => !!adminStore.access,
    save: (tokens: { accessToken?: string; refreshToken?: string }) => adminStore.set(tokens),
    logout: async () => {
        try {
            await api("/auth/logout", { method: "POST", body: { refreshToken: adminStore.refresh } });
        } catch {
            /* best effort */
        }
        adminStore.clear();
    },
};

/* ---------- judge API (PIN-based auth via /api/hyfit-judge) ---------- */

const JUDGE_BASE = "/api/hyfit-judge";

export type JudgeUser = {
    id: string;
    // Null for a session adopted from a console sign-in: that account's
    // credential is an email and password, not a staff ID and PIN.
    staffId: string | null;
    name: string;
    role: string;
    eventId: string | null;
    // The account's OWN event. Null for a console admin, who may act on any
    // event; set for field staff, who are hired for one and get a 403 on the
    // rest. The console's event picker reads this to know which it is.
    boundEventId?: string | null;
    stationNumber?: number;
    // Which check-in stage this volunteer staffs. Null for judges and for
    // anyone not on a counter — it replaced the counter assignment tables when
    // check-in state moved to RaceResult.
    checkinStage?: "STAGE_1_WRISTBAND" | "STAGE_2_TRANSPONDER" | null;
    enabled: boolean;
};

export async function judgeApi<T = any>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${JUDGE_BASE}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Request failed");
    return data;
}

/* A file, posted to the judge API as multipart.
 *
 * Its own function rather than a flag on judgeApi because of the header:
 * judgeApi sets `content-type: application/json` on every call, and a multipart
 * body sent under that header arrives at the server as an unparseable blob —
 * the boundary is generated by the browser and only appears if the header is
 * left off entirely. */
export async function judgeUpload<T = any>(
    path: string,
    file: File,
    fields: Record<string, string> = {},
): Promise<T> {
    const form = new FormData();
    form.append("file", file);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);

    const response = await fetch(`${JUDGE_BASE}${path}`, { method: "POST", body: form });

    // Not `await response.json()` straight off. This is the one call on the
    // console that can be answered by something OTHER than the application: an
    // image large enough to trip the reverse proxy's body limit is rejected by
    // nginx, which replies with an HTML error page — and parsing that as JSON
    // throws a SyntaxError about an unexpected "<", which is what the operator
    // then sees instead of "the file is too big".
    const body = await response.text();
    let data: any = null;
    try {
        data = body ? JSON.parse(body) : null;
    } catch {
        throw new Error(
            response.status === 413
                ? "That image is too large for the server to accept. Try one under 20 MB."
                : `Upload failed (HTTP ${response.status}). The server did not return a readable response.`,
        );
    }
    if (!response.ok) throw new Error(data?.error ?? data?.message ?? "Upload failed");
    return data;
}

export const judgeSession = {
    login: async (staffId: string, pin: string) => {
        const data = await judgeApi<{ user: JudgeUser }>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ staffId, pin, deviceLabel: typeof navigator !== "undefined" ? navigator.userAgent : "" }),
        });
        return data.user;
    },
    getUser: async (): Promise<JudgeUser | null> => {
        try {
            const data = await judgeApi<{ user: JudgeUser }>("/auth/session");
            return data.user ?? null;
        } catch {
            return null;
        }
    },
};

/* ---------- shared formatters ---------- */
export const fmtMs = (ms: number | null | undefined): string => {
    if (ms == null) return "—";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600),
        m = Math.floor((s % 3600) / 60),
        ss = s % 60;
    return (h ? `${h}:` : "") + `${String(m).padStart(h ? 2 : 1, "0")}:${String(ss).padStart(2, "0")}`;
};

export const fmtDate = (d: string | number | Date): string =>
    new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/* ---------------------------------------------------------------- event days
 *
 * A HYFIT edition runs over one day or two, and the API says which with a pair
 * of calendar days: `event_date` (Day 1) and `event_end_date` (the last day,
 * null when there is only one).
 *
 * NOT `new Date(value)`. A calendar day parses as UTC midnight, which in
 * Asia/Kolkata is half past five the previous evening — so a Saturday event
 * reads as Friday to everybody looking at it from India. Split the string and
 * rebuild it in local time instead. The first ten characters, not the whole
 * value: the endpoints send a plain `YYYY-MM-DD`, but a `date` column that ever
 * reaches JSON unconverted arrives as a full UTC timestamp, and that is exactly
 * the value this must not hand to `new Date()`.
 */
function calendarDay(value: string | null | undefined): Date | null {
    if (!value) return null;
    const [y, m, d] = value.slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
}

/** One day, spelled the way this product spells dates. */
export const fmtDay = (
    value: string | null | undefined,
    opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string => {
    const day = calendarDay(value);
    return day ? day.toLocaleDateString("en-IN", opts) : "";
};

/**
 * The span an event runs over, as one line.
 *
 *   one day          Sat, 15 Aug 2026
 *   two days, a month     15 - 16 Aug 2026
 *   two days, two months  31 Aug - 1 Sep 2026
 *   two days, two years   31 Dec 2026 - 1 Jan 2027
 *
 * The repeated half is dropped rather than printed twice: "15 Aug 2026 - 16 Aug
 * 2026" is the same information spending twice the width, on a card whose
 * whole job is to be read at a glance.
 *
 * `weekday` is for the public list, where the day of the week is the thing an
 * athlete is actually checking. It is only ever shown for a single-day event —
 * on a span it is two more words for a fact the dates already carry.
 */
export function fmtEventDays(
    start: string | null | undefined,
    end: string | null | undefined,
    opts: { weekday?: boolean; empty?: string } = {},
): string {
    const from = calendarDay(start);
    const empty = opts.empty ?? "";
    if (!from) return empty;

    const to = calendarDay(end);
    // Equal ends are stored as null (see hjudge-event-dates.util.ts), but a row
    // written before that rule, or by hand, must not render "15 - 15 Aug".
    if (!to || to.getTime() <= from.getTime())
        return from.toLocaleDateString("en-IN", {
            ...(opts.weekday ? { weekday: "short" as const } : {}),
            day: "numeric",
            month: "short",
            year: "numeric",
        });

    const sameYear = from.getFullYear() === to.getFullYear();
    const sameMonth = sameYear && from.getMonth() === to.getMonth();
    const head = from.toLocaleDateString("en-IN", {
        day: "numeric",
        ...(sameMonth ? {} : { month: "short" as const }),
        ...(sameYear ? {} : { year: "numeric" as const }),
    });
    const tail = to.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
    return `${head} - ${tail}`;
}

/** How many days the event runs. 1 for a single day and for no dates at all. */
export function eventDayCount(
    start: string | null | undefined,
    end: string | null | undefined,
): number {
    const from = calendarDay(start);
    const to = calendarDay(end);
    if (!from || !to) return 1;
    // Midday on both sides, so a DST shift between the two cannot round the
    // difference down to one day short.
    const ms = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 12).getTime()
        - new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12).getTime();
    const days = Math.round(ms / 86_400_000) + 1;
    return days > 1 ? days : 1;
}
