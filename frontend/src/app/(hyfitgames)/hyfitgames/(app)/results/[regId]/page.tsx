"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, session, fmtMs, fmtDate, appPath } from "../../../lib/api";
import { Spinner, Chip, statusChip, SectionTitle, ErrorNote } from "../../../lib/ui";

/* Which of my registrations belongs to this event.
 *
 * An event id names a race, not an entry, and one athlete routinely holds
 * several bibs at one race — one per category. Picking between them, in order:
 *
 *   ?reg=      names the entry explicitly, exactly as the race hub does. An
 *              unambiguous answer always wins.
 *   doubles    otherwise prefer a doubles entry. A pair's result is the one
 *              that cannot be reconstructed from anywhere else in the app —
 *              the team's time and placing only exist once both partners are
 *              in — and it is what these result URLs are read for.
 *   first      failing both, the earliest entry, which is all the ordering
 *              gives us.
 *
 * Returns null when logged out or not entered in this race. That is not an
 * error, it is the signal to show the public results instead: a spectator
 * opening the link has no result of their own to be shown. Logged out, `api`
 * throws rather than bouncing to the login screen — there is no refresh token
 * to fail — so the catch is what a signed-out visitor takes. */
async function myRegistrationFor(eventId: string): Promise<string | null> {
    if (!session.isLoggedIn()) return null;
    try {
        const mine: any = await api("/me/events");
        const entries = [...mine.upcoming, ...mine.past].filter(
            (x: any) => x.event_id === eventId,
        );
        const wanted = new URLSearchParams(window.location.search).get("reg");
        const picked =
            entries.find((x: any) => x.registration_id === wanted) ||
            entries.find((x: any) => /doubles/i.test(x.category || "")) ||
            entries[0];
        return picked?.registration_id ?? null;
    } catch {
        return null;
    }
}

// Athlete's own result: splits, ranks, protest, certificate. Ported from
// pages/MyResult.jsx.
export default function MyResult() {
    const { regId } = useParams<{ regId: string }>();
    const router = useRouter();
    const [d, setD] = useState<any>(null);
    const [err, setErr] = useState("");
    const [protest, setProtest] = useState("");
    const [sending, setSending] = useState(false);
    const [downloading, setDownloading] = useState(false);

    // `results/<id>` is the athlete's own result. The same shape of URL gets
    // used with an EVENT id, and it reads as "my result for this race" rather
    // than as the whole field — so an event id resolves to MY entry in it and
    // shows that, which is what this page is for. Swapping the URL for the
    // registration's own makes the result linkable and keeps the protest and
    // certificate actions pointed at a real entry.
    //
    // Only when there is no entry to show — a spectator, or an athlete who did
    // not race this one — does it hand over to the public results page, which
    // is the page that does show everybody.
    const load = () =>
        api(`/me/registrations/${regId}`)
            .then(setD)
            .catch(async (e) => {
                let mineId: string | null = null;
                try {
                    await api(`/events/${regId}`);
                    mineId = await myRegistrationFor(regId);
                } catch {
                    // Neither one of my registrations nor an event: the
                    // original "not found" is the honest message.
                    setErr(e.message);
                    return;
                }
                router.replace(
                    appPath(
                        mineId
                            ? `/hyfitgames/results/${mineId}`
                            : `/hyfitgames/events/${regId}/results`,
                    ),
                );
            });
    useEffect(() => {
        load();
    }, [regId]);

    if (err && !d) return <main className="p-5"><ErrorNote msg={err} /></main>;
    if (!d) return <Spinner />;

    const protestOpen =
        d.results_status === "provisional" &&
        (!d.protest_deadline || new Date(d.protest_deadline) > new Date());
    const certReady = d.results_status === "final" && d.status === "FIN";

    const sendProtest = async () => {
        setSending(true);
        setErr("");
        try {
            await api(`/me/registrations/${regId}/protest`, { method: "POST", body: { message: protest } });
            setProtest("");
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setSending(false);
        }
    };

    const downloadCert = async () => {
        setDownloading(true);
        setErr("");
        try {
            const res = await api<Response>(`/events/registrations/${regId}/certificate`, { raw: true });
            // On error the backend replies with JSON (HTTP 200 + { message }); a
            // real certificate comes back as application/pdf.
            const ct = res.headers.get("content-type") || "";
            if (!ct.includes("application/pdf")) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.message || "Could not download");
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = Object.assign(document.createElement("a"), {
                href: url,
                download: `HYFIT-certificate-${d.bib}.pdf`,
            });
            a.click();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setDownloading(false);
        }
    };

    return (
        <main className="px-5 pt-6">
            <Link href={appPath(`/hyfitgames/events/${d.event_id}`)} className="text-sm text-fog">
                ← Race hub
            </Link>
            <h1 className="mt-2 text-2xl font-black tracking-wide">{d.event_name.toUpperCase()}</h1>
            <p className="mt-1 text-sm text-fog">
                {fmtDate(d.event_date)} · Bib {d.bib} · {statusChip(d.status)}
            </p>

            <div className="mt-5 grid grid-cols-2 gap-3">
                {/* A doubles entry produces two results and the athlete owns
                    both: the team's, which is what places the pair, and their
                    own, which is what they personally ran. Showing only one
                    hides something they earned — the first version reduced the
                    individual total to a caption and dropped their category
                    placing entirely. Both get a card. */}
                {d.team_name ? (
                    <>
                        <div className="col-span-2 rounded-2xl border border-hyred/40 bg-hyred/10 p-4 text-center">
                            <p className="text-xs uppercase tracking-wide text-fog">
                                Team result · {d.category}
                            </p>
                            <p className="text-5xl font-black text-hyred-ink">
                                {d.team_total_ms != null ? fmtMs(d.team_total_ms) : "—"}
                            </p>
                            <p className="mt-1 text-xs text-fog">
                                {d.team_total_ms != null
                                    ? "Both partners finished — the team's time is the later one"
                                    : "Waiting on your partner to finish"}
                            </p>
                            <div className="mt-3 inline-flex items-baseline gap-2">
                                <span className="text-2xl font-black">
                                    {d.team_rank ? `#${d.team_rank}` : "—"}
                                </span>
                                <span className="text-[11px] uppercase tracking-wide text-fog">
                                    Team place · {d.team_name}
                                </span>
                            </div>

                            {/* Every member with their own leg and placing, not
                                just the partner's name. Both results belong to
                                the pair, and "who did I race with" is only half
                                of what the page is asked for. */}
                            <div className="mt-3 divide-y divide-smoke/60 border-t border-smoke/60 text-left">
                                {(d.team_members ?? []).map((m: any) => (
                                    <div
                                        key={m.registration_id}
                                        className="flex items-center gap-3 py-2"
                                    >
                                        <span className="w-10 shrink-0 font-mono text-xs text-fog">{m.bib}</span>
                                        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                                            {m.full_name}
                                            {m.is_self && (
                                                <span className="ml-1.5 rounded bg-smoke px-1.5 py-0.5 text-[10px] font-bold uppercase text-chalk">
                                                    You
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-sm font-black">
                                            {m.total_ms ? fmtMs(m.total_ms) : m.status}
                                        </span>
                                        <span className="w-12 shrink-0 text-right text-xs text-fog">
                                            {m.category_rank ? `#${m.category_rank}` : "—"}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="col-span-2 rounded-2xl border border-smoke bg-coal p-4 text-center">
                            <p className="text-xs uppercase tracking-wide text-fog">
                                Your individual{" "}
                                {d.results_status === "final" ? "time" : "provisional time"}
                            </p>
                            <p className="text-4xl font-black">{fmtMs(d.total_ms)}</p>
                            <p className="mt-1 text-xs text-fog">
                                What you ran yourself · bib {d.bib}
                            </p>
                            {d.results_status === "provisional" && (
                                <div className="mt-2">
                                    <Chip tone="warn">Subject to protest window</Chip>
                                </div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="col-span-2 rounded-2xl border border-smoke bg-coal p-4 text-center">
                        <p className="text-xs uppercase tracking-wide text-fog">
                            {d.results_status === "final"
                                ? "Official time"
                                : d.results_status === "provisional"
                                  ? "Provisional time"
                                  : "Time"}
                        </p>
                        <p className="text-5xl font-black text-hyred-ink">{fmtMs(d.total_ms)}</p>
                        {d.results_status === "provisional" && (
                            <div className="mt-2">
                                <Chip tone="warn">Subject to protest window</Chip>
                            </div>
                        )}
                    </div>
                )}

                {[
                    // Placings are within the contest entered, never across the
                    // event — a doubles time and a solo time are not the same
                    // race. For a pair these are the individual placings, sitting
                    // under the individual time they were measured from; the
                    // team's placing is on the team card above.
                    [d.category || "Category", d.overall_rank],
                    ["Gender", d.gender_rank],
                    [`Age ${d.age_group || ""}`, d.age_group_rank],
                ].map(([l, v]) => (
                    <div key={l as string} className="rounded-xl bg-coal p-3 text-center">
                        <p className="text-2xl font-black">{v ? `#${v}` : "—"}</p>
                        <p className="truncate text-[11px] uppercase tracking-wide text-fog">{l}</p>
                    </div>
                ))}
                <Link
                    href={appPath(`/hyfitgames/events/${d.event_id}/scorecard/${d.id}`)}
                    className="rounded-xl border border-hyred bg-hyred/10 p-3 text-center text-sm font-bold uppercase tracking-wide text-hyred-ink"
                >
                    View Scorecard →
                </Link>
                <button
                    onClick={downloadCert}
                    disabled={!certReady || downloading}
                    className="rounded-xl bg-hyred p-3 text-center text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                >
                    {downloading ? "Preparing…" : certReady ? "Certificate ⇩" : "Certificate locked"}
                </button>
            </div>
            {!certReady && (
                <p className="mt-2 text-xs text-fog">
                    {d.status !== "FIN"
                        ? "Certificates are issued to finishers once results are final."
                        : "Your certificate unlocks when results are declared final."}
                </p>
            )}

            <SectionTitle>Splits</SectionTitle>
            <div className="overflow-hidden rounded-xl border border-smoke">
                {d.splits.map((s: any) => (
                    <div
                        key={s.seq}
                        className="flex items-center gap-3 border-b border-smoke bg-coal px-3 py-2.5 text-sm last:border-0"
                    >
                        <span className="w-5 text-hyred-ink">{s.seq}</span>
                        <span className="flex-1">{s.name}</span>
                        <span className="font-black">{fmtMs(s.split_ms)}</span>
                        <span className="w-16 text-right text-xs text-fog">{fmtMs(Number(s.cum_ms))}</span>
                    </div>
                ))}
                {d.splits.length === 0 && <p className="bg-coal p-4 text-sm text-fog">No splits recorded yet.</p>}
            </div>

            <SectionTitle>Query a result</SectionTitle>
            {d.protests.map((p: any) => (
                <div key={p.id} className="mb-3 rounded-xl border border-smoke bg-coal p-4 text-sm">
                    <div className="flex justify-between">
                        <Chip tone={p.status === "open" ? "warn" : p.status === "resolved" ? "ok" : "default"}>
                            {p.status}
                        </Chip>
                        <span className="text-xs text-fog">{fmtDate(p.created_at)}</span>
                    </div>
                    <p className="mt-2">{p.message}</p>
                    {p.response && (
                        <p className="mt-2 border-l-2 border-hyred pl-3 text-fog">Organiser: {p.response}</p>
                    )}
                </div>
            ))}
            {protestOpen ? (
                <div className="space-y-2">
                    <textarea
                        className="w-full rounded-xl border border-smoke bg-coal p-3 text-sm outline-none focus:border-hyred"
                        rows={3}
                        placeholder="Something off with your splits or status? Tell us — the timing team reviews every protest."
                        value={protest}
                        onChange={(e) => setProtest(e.target.value)}
                    />
                    <ErrorNote msg={err} />
                    <button
                        onClick={sendProtest}
                        disabled={protest.trim().length < 10 || sending}
                        className="w-full rounded-xl border border-hyred py-3 text-sm font-bold uppercase tracking-wide text-hyred-ink disabled:opacity-40"
                    >
                        {sending ? "Submitting…" : "Submit protest"}
                    </button>
                    {d.protest_deadline && (
                        <p className="text-center text-xs text-fog">
                            Window closes {new Date(d.protest_deadline).toLocaleString("en-IN")}
                        </p>
                    )}
                </div>
            ) : (
                <p className="text-sm text-fog">
                    {d.results_status === "final"
                        ? "Results are final — the protest window has closed."
                        : "Protests open when provisional results are published."}
                </p>
            )}
        </main>
    );
}
