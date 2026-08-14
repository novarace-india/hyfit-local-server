"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, session, appPath } from "../lib/api";
import { ErrorNote } from "../lib/ui";

import { ALL_COUNTRY_CODES } from "../lib/countries";
import HfgThemeToggle from "../lib/theme-toggle";

// Athlete mobile + OTP login. Ported from pages/Login.jsx.
export default function Login() {
    const router = useRouter();
    // "who" is reached only when one number holds several athletes, which the
    // phone + name identity makes possible on purpose: a parent enters two
    // children on their own number and those are two people. The OTP proves the
    // NUMBER; this step says which of them is signing in.
    const [step, setStep] = useState<"mobile" | "otp" | "who">("mobile");
    const [profiles, setProfiles] = useState<{ id: string; full_name: string }[]>([]);
    const [countryCode, setCountryCode] = useState("+91");
    const [mobile, setMobile] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const [cooldown, setCooldown] = useState(0);
    const otpRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!cooldown) return;
        const t = setInterval(() => setCooldown((c) => c - 1), 1000);
        return () => clearInterval(t);
    }, [cooldown]);

    const getFullMobile = () => {
        const cleanCode = countryCode.replace(/\D/g, "");
        const cleanMobile = mobile.replace(/\D/g, "");
        return `${cleanCode}${cleanMobile}`;
    };

    const sendOtp = async () => {
        setErr("");
        setBusy(true);
        try {
            await api("/auth/otp/request", { method: "POST", body: { mobile: getFullMobile() } });
            setStep("otp");
            setCooldown(45);
            setTimeout(() => otpRef.current?.focus(), 50);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };

    const verify = async (value: string) => {
        setErr("");
        setBusy(true);
        try {
            const data = await api("/auth/otp/verify", {
                method: "POST",
                body: { mobile: getFullMobile(), code: value },
            });
            // Signed in already, as the first athlete on the number. The code is
            // spent, so the chooser below cannot re-verify — it switches with
            // the session just issued, which is only ever allowed to move
            // between profiles on the same proved number.
            session.save(data);
            if ((data.profiles?.length ?? 1) > 1) {
                setProfiles(data.profiles);
                setStep("who");
                setBusy(false);
                return;
            }
            router.replace(appPath("/hyfitgames"));
        } catch (e: any) {
            setErr(e.message);
            setBusy(false);
        }
    };

    const chooseProfile = async (athleteId: string) => {
        setErr("");
        setBusy(true);
        try {
            const data = await api("/auth/profile/switch", {
                method: "POST",
                body: { athleteId },
            });
            session.save(data);
            router.replace(appPath("/hyfitgames"));
        } catch (e: any) {
            setErr(e.message);
            setBusy(false);
        }
    };

    const onCode = (v: string) => {
        const clean = v.replace(/\D/g, "").slice(0, 6);
        setCode(clean);
        if (clean.length === 6) verify(clean);
    };

    return (
        <main className="hfg-app relative mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 pb-24">
            {/* The sign-in screen is a centred column with no chrome to hang a
                control off, so the switch gets its own corner. Without it the
                theme is unreachable until you are signed in — and an athlete
                checking a start time outdoors is exactly who needs it. */}
            <div className="absolute right-4 top-4">
                <HfgThemeToggle />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src="/hyfitgames/hyfit-logo-red-SMZJ9JPG.png"
                alt="HYFIT"
                className="max-h-16 w-auto object-contain"
            />
            <p className="mt-2 text-sm font-bold uppercase tracking-[0.3em] text-fog">Run. Lift. Live.</p>

            {step === "mobile" && (
                <form
                    className="mt-10 space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        sendOtp();
                    }}
                >
                    <label className="block text-sm text-fog" htmlFor="mobile">
                        Registered mobile number
                    </label>
                    <div className="flex items-center rounded-xl border border-smoke bg-coal focus-within:border-hyred overflow-hidden">
                        <div className="relative flex-none min-w-[76px] py-3.5 border-r border-smoke bg-coal/50 flex items-center justify-between px-3">
                            <span className="text-sm font-semibold text-chalk pointer-events-none">{countryCode}</span>
                            <span className="pointer-events-none text-[10px] text-fog ml-1.5">▼</span>
                            <select
                                aria-label="Country Code"
                                value={countryCode}
                                onChange={(e) => setCountryCode(e.target.value)}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-sm"
                            >
                                {ALL_COUNTRY_CODES.map((c) => (
                                    <option key={`${c.iso}-${c.code}`} value={c.code} className="bg-coal text-chalk">
                                        {c.flag} {c.code} ({c.country})
                                    </option>
                                ))}
                            </select>
                        </div>
                        <input
                            id="mobile"
                            type="tel"
                            inputMode="numeric"
                            autoComplete="tel"
                            autoFocus
                            className="flex-1 bg-transparent py-3.5 px-3 outline-none placeholder:text-smoke text-chalk"
                            placeholder="Mobile number"
                            value={mobile}
                            onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 12))}
                        />
                    </div>
                    <ErrorNote msg={err} />
                    <button
                        disabled={mobile.length < 7 || busy}
                        className="w-full rounded-xl bg-hyred py-3.5 font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                    >
                        {busy ? "Sending…" : "Get OTP"}
                    </button>
                    <p className="text-center text-xs text-fog">
                        Use the number you registered with. New here? Registration happens at hyfitgames.com.
                    </p>
                </form>
            )}

            {step === "otp" && (
                <div className="mt-10 space-y-4">
                    <p className="text-sm text-fog">
                        Enter the 6-digit code sent to <span className="text-chalk">{countryCode} {mobile}</span>{" "}
                        <button
                            className="text-hyred-ink underline"
                            onClick={() => {
                                setStep("mobile");
                                setCode("");
                                setErr("");
                            }}
                        >
                            change
                        </button>
                    </p>
                    <input
                        ref={otpRef}
                        type="tel"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        className="w-full rounded-xl border border-smoke bg-coal py-4 text-center text-2xl tracking-[0.6em] outline-none focus:border-hyred"
                        placeholder="••••••"
                        value={code}
                        onChange={(e) => onCode(e.target.value)}
                    />
                    <ErrorNote msg={err} />
                    <button
                        disabled={code.length !== 6 || busy}
                        onClick={() => verify(code)}
                        className="w-full rounded-xl bg-hyred py-3.5 font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                    >
                        {busy ? "Verifying…" : "Log in"}
                    </button>
                    <button
                        disabled={cooldown > 0 || busy}
                        onClick={sendOtp}
                        className="w-full py-2 text-sm text-fog disabled:opacity-50"
                    >
                        {cooldown > 0 ? `Resend OTP in ${cooldown}s` : "Resend OTP"}
                    </button>
                </div>
            )}

            {/* Several people race on one number — a parent and their children,
                most often. The number is already proved at this point; this only
                says which of them is here. */}
            {step === "who" && (
                <div className="mt-10 space-y-3">
                    <p className="text-sm text-fog">
                        This number has {profiles.length} athletes. Who is signing in?
                    </p>
                    {profiles.map((p) => (
                        <button
                            key={p.id}
                            disabled={busy}
                            onClick={() => chooseProfile(p.id)}
                            className="flex w-full items-center justify-between rounded-xl border border-smoke bg-coal px-4 py-3.5 text-left disabled:opacity-40"
                        >
                            <span className="font-semibold">{p.full_name}</span>
                            <span className="text-hyred-ink">→</span>
                        </button>
                    ))}
                    <ErrorNote msg={err} />
                </div>
            )}
        </main>
    );
}
