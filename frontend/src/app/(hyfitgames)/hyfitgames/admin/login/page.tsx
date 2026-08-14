"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, adminSession, appPath } from "../../lib/api";
import { ErrorNote } from "../../lib/ui";
import HfgThemeToggle from "../../lib/theme-toggle";

// Admin login. Ported from pages/admin/AdminLogin.jsx.
export default function AdminLogin() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErr("");
        setBusy(true);
        try {
            const data = await api("/auth/admin/login", { method: "POST", body: { email, password } });
            adminSession.save(data);
            router.replace(appPath("/hyfitgames/admin"));
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="hfg-admin relative flex min-h-dvh flex-col justify-center bg-ink px-6">
            <div className="absolute right-4 top-4">
                <HfgThemeToggle />
            </div>
            <div className="mx-auto w-full max-w-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src="/hyfitgames/hyfit-logo-red-SMZJ9JPG.png"
                    alt="HYFIT"
                    className="mx-auto max-h-12 w-auto object-contain"
                />
                <h1 className="mt-6 text-center text-xl font-black uppercase tracking-wide">Admin Portal</h1>
                <p className="mt-1 text-center text-sm text-fog">Sign in with your admin credentials</p>

                <form className="mt-8 space-y-4" onSubmit={submit}>
                    <div>
                        <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">Email</label>
                        <input
                            type="email"
                            required
                            autoFocus
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full rounded-xl border border-smoke bg-coal px-4 py-3 outline-none focus:border-hyred"
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">Password</label>
                        <input
                            type="password"
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full rounded-xl border border-smoke bg-coal px-4 py-3 outline-none focus:border-hyred"
                        />
                    </div>
                    <ErrorNote msg={err} />
                    <button
                        disabled={busy}
                        className="w-full rounded-xl bg-hyred py-3.5 font-bold uppercase tracking-wide disabled:opacity-40 text-onfill"
                    >
                        {busy ? "Signing in…" : "Sign in"}
                    </button>
                    <p className="text-center text-xs text-fog">Dev: admin@hyfitgames.com / admin123</p>
                </form>
            </div>
        </main>
    );
}
