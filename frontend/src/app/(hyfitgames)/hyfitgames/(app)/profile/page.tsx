"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, session, appPath } from "../../lib/api";
import { Spinner, SectionTitle, ErrorNote } from "../../lib/ui";

const FIELDS: [string, string, string][] = [
    ["full_name", "Full name (as it should appear on your certificate)", "text"],
    ["email", "Email", "email"],
    ["dob", "Date of birth", "date"],
    ["city", "City", "text"],
    ["state", "State", "text"],
    ["emergency_name", "Emergency contact name", "text"],
    ["emergency_phone", "Emergency contact number", "tel"],
];

// Profile editor. Ported from pages/Profile.jsx.
export default function Profile() {
    const router = useRouter();
    const [me, setMe] = useState<any>(null);
    const [form, setForm] = useState<any>({});
    const [err, setErr] = useState("");
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api("/me")
            .then((m) => {
                setMe(m);
                setForm(m);
            })
            .catch((e) => setErr(e.message));
    }, []);
    if (err && !me) return <main className="p-5"><ErrorNote msg={err} /></main>;
    if (!me) return <Spinner />;

    const set = (k: string) => (e: any) => {
        setForm({ ...form, [k]: e.target.value });
        setSaved(false);
    };

    const save = async () => {
        setBusy(true);
        setErr("");
        try {
            const body: any = {};
            for (const [k] of FIELDS) if ((form[k] ?? "") !== (me[k] ?? "")) body[k] = form[k] ?? "";
            for (const k of ["gender", "blood_group", "tshirt_size"])
                if ((form[k] ?? "") !== (me[k] ?? "")) body[k] = form[k];
            if (body.dob) body.dob = String(body.dob).slice(0, 10);
            const updated = await api("/me", { method: "PATCH", body });
            setMe(updated);
            setForm(updated);
            setSaved(true);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };

    const logout = async () => {
        await session.logout();
        router.replace(appPath("/hyfitgames/login"));
    };

    const input = "w-full rounded-xl border border-smoke bg-coal px-3 py-3 text-sm outline-none focus:border-hyred";

    return (
        <main className="px-5 pt-6">
            <h1 className="text-3xl font-black tracking-wide">PROFILE</h1>
            <p className="mt-1 text-sm text-fog">
                Logged in as +{me.mobile}. To change your mobile number, contact the organiser — it's your login
                identity.
            </p>

            <Link
                href={appPath("/hyfitgames/my-stats")}
                className="mt-4 block rounded-xl border border-hyred bg-hyred/10 px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-hyred-ink"
            >
                My Performance Dashboard →
            </Link>

            <SectionTitle>Personal details</SectionTitle>
            <div className="space-y-3">
                {FIELDS.map(([k, label, type]) => (
                    <label key={k} className="block text-sm">
                        <span className="text-fog">{label}</span>
                        <input
                            type={type}
                            className={`${input} mt-1`}
                            value={(form[k] ?? "") && type === "date" ? String(form[k]).slice(0, 10) : (form[k] ?? "")}
                            onChange={set(k)}
                        />
                    </label>
                ))}
                <div className="grid grid-cols-3 gap-3">
                    <label className="block text-sm">
                        <span className="text-fog">Gender</span>
                        <select className={`${input} mt-1`} value={form.gender ?? ""} onChange={set("gender")}>
                            <option value="">—</option>
                            <option value="male">Male</option>
                            <option value="female">Female</option>
                            <option value="other">Other</option>
                        </select>
                    </label>
                    <label className="block text-sm">
                        <span className="text-fog">Blood group</span>
                        <select className={`${input} mt-1`} value={form.blood_group ?? ""} onChange={set("blood_group")}>
                            <option value="">—</option>
                            {["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"].map((b) => (
                                <option key={b}>{b}</option>
                            ))}
                        </select>
                    </label>
                    <label className="block text-sm">
                        <span className="text-fog">T-shirt</span>
                        <select className={`${input} mt-1`} value={form.tshirt_size ?? ""} onChange={set("tshirt_size")}>
                            <option value="">—</option>
                            {["XS", "S", "M", "L", "XL", "XXL"].map((s) => (
                                <option key={s}>{s}</option>
                            ))}
                        </select>
                    </label>
                </div>
            </div>

            <ErrorNote msg={err} />
            {saved && (
                <p className="mt-2 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">Profile saved.</p>
            )}
            <button
                onClick={save}
                disabled={busy}
                className="mt-4 w-full rounded-xl bg-hyred py-3.5 font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
            >
                {busy ? "Saving…" : "Save changes"}
            </button>
            <button
                onClick={logout}
                className="mt-3 w-full rounded-xl border border-smoke py-3.5 text-sm font-semibold text-fog"
            >
                Log out
            </button>
        </main>
    );
}
