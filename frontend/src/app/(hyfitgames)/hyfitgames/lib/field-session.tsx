"use client";

/* The console's field-operations session.
 *
 * /hyfitgames/admin is now one console over two backends: the athlete platform
 * (/api/hyfitgames, JWT in localStorage) and field operations (/api/hyfit-judge,
 * opaque session cookie). Team, Operations and the operational half of Events
 * all talk to the second one.
 *
 * Signing in to the console opens BOTH sessions — see openLinkedSession in
 * hjudge-auth.service.ts. The field session is the shorter of the two (12
 * hours, against a console refresh token measured in days), so finding no
 * field session says nothing about whether the operator is entitled to one:
 * this provider asks the console to open a fresh one before it concludes
 * anything, which also covers a browser signed in before that link existed.
 *
 * Only an operator with no console session at all — the standalone judge app —
 * reaches the staff ID and PIN prompt. Holding it here rather than in each page
 * is what stops that prompt appearing twice.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, adminSession, judgeApi, judgeSession, type JudgeUser } from "./api";

type FieldSession = {
    user: JudgeUser | null;
    /** Null until the first session check has returned. */
    ready: boolean;
    signIn: (staffId: string, pin: string) => Promise<void>;
    signOut: () => Promise<void>;
    reload: () => Promise<void>;
};

const Ctx = createContext<FieldSession | null>(null);

export function FieldSessionProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<JudgeUser | null>(null);
    const [ready, setReady] = useState(false);

    const reload = useCallback(async () => {
        let found = await judgeSession.getUser();
        // No field session, but a live console session: adopt one rather than
        // asking for a credential the console account may not even have. The
        // link is refused only for an account that is gone or disabled, in
        // which case the sign-in prompt below is the honest answer.
        if (!found && adminSession.isLoggedIn()) {
            try {
                await api("/auth/admin/field-session", { method: "POST", role: "admin" });
                found = await judgeSession.getUser();
            } catch {
                /* fall through to the credential prompt */
            }
        }
        setUser(found);
        setReady(true);
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    const signIn = useCallback(
        async (staffId: string, pin: string) => {
            await judgeSession.login(staffId, pin);
            await reload();
        },
        [reload],
    );

    const signOut = useCallback(async () => {
        try {
            await judgeApi("/auth/logout", { method: "POST", body: "{}" });
        } catch {
            /* best effort — the console sign-out must not block on this */
        }
        setUser(null);
    }, []);

    return <Ctx.Provider value={{ user, ready, signIn, signOut, reload }}>{children}</Ctx.Provider>;
}

export function useFieldSession(): FieldSession {
    const value = useContext(Ctx);
    if (!value) throw new Error("useFieldSession must be used inside FieldSessionProvider");
    return value;
}

/* The one place the field credential is ever asked for. Rendered by the pages
 * that need field data, in place of their content, when no field session could
 * be opened — which for a console operator means the account is disabled, not
 * that it needs a second credential. */
export function FieldSignIn({ what }: { what: string }) {
    const { signIn } = useFieldSession();
    const [form, setForm] = useState({ staffId: "", pin: "" });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
            await signIn(form.staffId, form.pin);
        } catch (e: any) {
            setErr(e.message);
            setBusy(false);
        }
    };

    return (
        <div className="mt-6 max-w-sm rounded-xl border border-smoke bg-coal p-5">
            <h2 className="text-sm font-bold uppercase tracking-wide">Field credential required</h2>
            <p className="mt-1 text-xs text-fog">
                No field session could be opened for this login, so {what} needs your staff ID and PIN. Sign in once and
                it carries across every operations screen.
            </p>
            <form className="mt-4 space-y-3" onSubmit={submit}>
                <div>
                    <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">Staff ID</label>
                    <input
                        required
                        autoFocus
                        value={form.staffId}
                        onChange={(e) => setForm({ ...form, staffId: e.target.value })}
                        className="w-full rounded-lg border border-smoke bg-ink px-3 py-2.5 text-sm outline-none focus:border-hyred"
                    />
                </div>
                <div>
                    <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">PIN</label>
                    <input
                        required
                        type="password"
                        inputMode="numeric"
                        value={form.pin}
                        onChange={(e) => setForm({ ...form, pin: e.target.value })}
                        className="w-full rounded-lg border border-smoke bg-ink px-3 py-2.5 text-sm outline-none focus:border-hyred"
                    />
                </div>
                {err && <p className="rounded-lg bg-hyred/15 px-3 py-2 text-sm text-bad">{err}</p>}
                <button
                    disabled={busy}
                    className="rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                >
                    {busy ? "Signing in…" : "Sign in"}
                </button>
            </form>
        </div>
    );
}
