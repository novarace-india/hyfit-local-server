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
                window.location.href = appPath(role === "admin" ? "/hyfitgames/admin/login" : "/hyfitgames/login");
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
    // No check-in stage. A counter runs whichever hand-over the athlete in
    // front of it is due, worked out from the equipment they already hold, so
    // there is nothing about a stage to hold against a volunteer.
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
