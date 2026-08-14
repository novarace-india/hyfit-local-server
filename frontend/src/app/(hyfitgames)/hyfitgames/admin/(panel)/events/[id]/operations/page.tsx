"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { appPath, judgeApi } from "../../../../../lib/api";
import { Spinner, ErrorNote } from "../../../../../lib/ui";
import { FieldSignIn, useFieldSession } from "../../../../../lib/field-session";
import EventPicker from "../event-picker";

type Config = {
    participantApiUrl: string;
    updateApiUrl: string;
    // The wristband -> BIB mapping table: its own Custom API, fetched whole.
    // Nothing about it is derived from the bib endpoint.
    mapLookupUrl: string;
    participantMapping: string;
    updateMapping: string;
    declarationText: string;
    // The check-in window, in minutes either side of the athlete's timeslot.
    // Empty close = the counter never closes for them.
    checkinWindowEnabled: boolean;
    checkinOpensBeforeMinutes: number;
    checkinClosesAfterMinutes: number | null;
};

// "240" is unreadable at a glance; "4 h" is what the organiser asked for.
function durationLabel(minutes: number) {
    if (!Number.isFinite(minutes) || minutes < 0) return "—";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${rest} min`;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// A worked example under the field, because "240 minutes before" and "opens at
// midnight for the 4 AM wave" are the same setting and only one of them is the
// question the organiser is actually asking.
function slotPreview(minutesBefore: number) {
    if (!Number.isFinite(minutesBefore) || minutesBefore < 0) return "—";
    const opens = ((4 * 60 - Math.round(minutesBefore)) % 1440 + 1440) % 1440;
    const hour = Math.floor(opens / 60);
    const minute = opens % 60;
    const suffix = minutesBefore > 4 * 60 ? " the day before" : "";
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}${suffix}`;
}

const defaultDeclaration =
    "I confirm that my participant details are correct and that I have received the assigned race equipment.";

// Module-level because load() needs them too: an event with no configuration of
// its own must reset this form, not inherit the last event's.
const defaultConfig: Config = {
    participantApiUrl: "",
    updateApiUrl: "",
    mapLookupUrl: "",
    participantMapping: '{"listPath":"","bib":"Bib","name":"name","category":"Contest","contestId":"ContestID","gender":"Gender","dateOfBirth":"DateOfBirth","club":"Club","wave":"Wave","timeslot":"TimeSlot","contestDate":"ContestDate","mobile":"mobile"}',
    // Every field the check-in and judge apps write back, spelled with the
    // names RaceResult uses by default. An organiser whose event names them
    // differently edits the value, never the key.
    updateMapping: JSON.stringify(
        {
            stage1checkin: "stage1checkin",
            stage1checkintime: "stage1checkintime",
            wristband: "wristbandID",
            wristbandassignedby: "wristbandidAssignedBy",
            stage2checkin: "stage2checkin",
            stage2checkintime: "stage2checkintime",
            transponder1: "Transponder1",
            transponderassignedby: "transponderAssignedBy",
            station1penalty: "station1penalty",
            station2penalty: "station2penalty",
            station3penalty: "station3penalty",
            station4penalty: "station4penalty",
            station5penalty: "station5penalty",
            station6penalty: "station6penalty",
            station1ics: "station1ics",
            station2ics: "station2ics",
            station3ics: "station3ics",
            station4ics: "station4ics",
            station5ics: "station5ics",
            station6ics: "station6ics",
            athletenotes: "athletenotes",
            cognitiveskillpenalty: "cognitiveskillpenalty",
            cognitiveskillbonus: "cognitiveskillbonus",
            cognitivememorisetime: "cognitivememorisetime",
            run1time: "run1time",
            station1time: "station1time",
            run2time: "run2time",
            station2time: "station2time",
            run3time: "run3time",
            station3time: "station3time",
            run4time: "run4time",
            station4time: "station4time",
            run5time: "run5time",
            station5time: "station5time",
            run6time: "run6time",
            station6time: "station6time",
            cognitiverecalltime: "cognitiverecalltime",
            tyrefliprecalltime: "tyrefliprecalltime",
            recalltofinishtime: "recalltofinishtime",
            totalracetime: "totalracetime",
            starttod: "starttod",
            run1tod: "run1tod",
            station1tod: "station1tod",
            run2tod: "run2tod",
            station2tod: "station2tod",
            run3tod: "run3tod",
            station3tod: "station3tod",
            run4tod: "run4tod",
            station4tod: "station4tod",
            run5tod: "run5tod",
            station5tod: "station5tod",
            run6tod: "run6tod",
            station6tod: "station6tod",
            cognitiverecalltod: "cognitiverecalltod",
            finishtod: "finishtod",
            status: "Status",
        },
        null,
        2,
    ),
    declarationText: defaultDeclaration,
    checkinWindowEnabled: false,
    checkinOpensBeforeMinutes: 240,
    checkinClosesAfterMinutes: null,
};

export default function OperationsPage() {
    // Operations is a screen OF an event: the RaceResult endpoints on this page
    // belong to the event in the URL, not to whichever event the field session
    // resolves to.
    const { id: eventId } = useParams<{ id: string }>();
    const scoped = (path: string) => `${path}${path.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(eventId)}`;
    const router = useRouter();
    const { user, ready } = useFieldSession();
    const [config, setConfig] = useState<Config>(defaultConfig);
    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        setErr("");
        try {
            const configData = await judgeApi<{ config: any }>(scoped("/admin/config"));
            // The else matters now that the event can change under this form:
            // an event with no configuration of its own has to clear it. Left
            // out, the previous event's RaceResult endpoint would sit in the
            // fields — and Publish would write it to the event now in the URL.
            setConfig(
                configData.config
                    ? {
                          participantApiUrl: configData.config.participantApiUrl,
                          updateApiUrl: configData.config.updateApiUrl,
                          mapLookupUrl: configData.config.mapLookupUrl ?? "",
                          participantMapping: JSON.stringify(configData.config.participantMapping, null, 2),
                          updateMapping: JSON.stringify(configData.config.updateMapping, null, 2),
                          declarationText: configData.config.declarationText ?? defaultDeclaration,
                          checkinWindowEnabled: configData.config.checkinWindowEnabled ?? false,
                          checkinOpensBeforeMinutes: configData.config.checkinOpensBeforeMinutes ?? 240,
                          checkinClosesAfterMinutes: configData.config.checkinClosesAfterMinutes ?? null,
                      }
                    : defaultConfig,
            );
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setLoading(false);
        }
    }, [eventId]);

    // A message about the previous event does not belong on this one.
    useEffect(() => {
        setMsg("");
    }, [eventId]);

    // Waits for the console-level field session before fetching: every call
    // below is cookie-authenticated, so firing them before the session resolves
    // just produces a wall of "Not authorized".
    useEffect(() => {
        if (user) void load();
        else if (ready) setLoading(false);
    }, [user, ready, load]);

    // The roster import moved to the event's own Roster tab, because there is
    // one roster now and this screen could only ever have aimed at the active
    // event. This pulls the same endpoint into the same tables — it is a move,
    // not a removal.
    const syncParticipants = () => {
        router.push(appPath(`/hyfitgames/admin/events/${eventId}`));
    };

    const saveConfig = async () => {
        setErr("");
        try {
            const draft = await judgeApi<{ id: string; version: number }>("/admin/config", {
                method: "PUT",
                body: JSON.stringify({
                    eventId,
                    participantApiUrl: config.participantApiUrl,
                    updateApiUrl: config.updateApiUrl,
                    mapLookupUrl: config.mapLookupUrl,
                    participantMapping: JSON.parse(config.participantMapping),
                    updateMapping: JSON.parse(config.updateMapping),
                    declarationText: config.declarationText,
                    checkinWindowEnabled: config.checkinWindowEnabled,
                    checkinOpensBeforeMinutes: config.checkinOpensBeforeMinutes,
                    checkinClosesAfterMinutes: config.checkinClosesAfterMinutes,
                }),
            });
            await judgeApi("/admin/config", {
                method: "POST",
                body: JSON.stringify({ id: draft.id, eventId }),
            });
            setMsg(`Configuration v${draft.version} published`);
            setTimeout(() => setMsg(""), 3000);
            await load();
        } catch (e: any) {
            setErr(e.message);
        }
    };

    if (!ready || (loading && user)) return <Spinner />;

    if (!user) {
        return (
            <div>
                <h1 className="text-2xl font-black uppercase tracking-wide">Operations</h1>
                <p className="mt-1 text-sm text-fog">RaceResult integration for this event</p>
                <FieldSignIn what="RaceResult integration" />
            </div>
        );
    }

    return (
        <div>
            <Link href={`/hyfitgames/admin/events/${eventId}`} className="text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk">
                ← Back to event
            </Link>
            <h1 className="mt-2 text-2xl font-black uppercase tracking-wide">Operations</h1>
            <p className="mt-1 text-sm text-fog">RaceResult integration for this event — the endpoints check-in and the judge app read and write through</p>
            <EventPicker eventId={eventId} segment="operations" />

            {msg && <div className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">{msg}</div>}
            <ErrorNote msg={err} />

            {(
                <div className="mt-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-sm font-bold uppercase tracking-wide">RaceResult 14 Configuration</h2>
                            <p className="mt-1 text-xs text-fog">Publish the endpoint and mappings here; the roster is then imported from the event's Roster tab, into the one roster check-in and the athlete platform share.</p>
                        </div>
                        <button
                            onClick={syncParticipants}
                            className="rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill disabled:opacity-40"
                        >
                            Import roster on the event →
                        </button>
                    </div>


                    {/* There is no server-side write-back queue any more: both
                        field apps write to RaceResult synchronously, and a write
                        that cannot land is retried from the tablet that made it
                        (the judge app's own pending-sync list). Nothing waits
                        here for an operator to re-send. */}

                    <div className="mt-6 space-y-4">
                        <div>
                            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">Participant fetch endpoint</label>
                            <input
                                value={config.participantApiUrl}
                                onChange={(e) => setConfig({ ...config, participantApiUrl: e.target.value })}
                                placeholder="Complete GET endpoint"
                                className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm outline-none focus:border-hyred"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">Participant update endpoint</label>
                            <input
                                value={config.updateApiUrl}
                                onChange={(e) => setConfig({ ...config, updateApiUrl: e.target.value })}
                                placeholder="https://<server>/_<eventID>/api/<CUSTOM_API_KEY>"
                                className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm outline-none focus:border-hyred"
                            />
                            <p className="mt-1 text-xs text-fog">
                                Paste the URL of a RaceResult Custom API whose API details are <span className="font-mono">part/savevalue</span> —
                                the key belongs in the path, not the word savevalue. Check-in and the judge app append
                                <span className="font-mono"> bib</span>, <span className="font-mono">fieldname</span>,
                                <span className="font-mono"> value</span> and <span className="font-mono">nohistory=0</span> themselves.
                            </p>
                        </div>
                        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-fog">Equipment Mapping · Required</h3>
                        <div className="space-y-3">
                            <div>
                                <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">
                                    Equipment mapping endpoint
                                </label>
                                <input
                                    value={config.mapLookupUrl}
                                    onChange={(e) => setConfig({ ...config, mapLookupUrl: e.target.value })}
                                    placeholder="Leave empty — no counter can check anyone in"
                                    className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm outline-none focus:border-hyred"
                                />
                                <p className="mt-1 text-xs text-fog">
                                    A separate Custom API from the participant endpoint — paste the whole URL, it is not derived
                                    from it. It is the counter&apos;s authority on equipment, and check-in cannot run without it: what a
                                    BIB already holds is what decides whether that athlete is due a wristband or a transponder, and
                                    who a scanned code belongs to is what stops the same band going to two people. It must carry a
                                    BIB column and both asset columns.
                                </p>
                            </div>
                            {config.mapLookupUrl.trim() && (
                                <div className="rounded-lg border border-smoke bg-coal px-3 py-2.5">
                                    <p className="text-xs font-bold uppercase tracking-wider text-fog">What a counter will do</p>
                                    <ol className="mt-1 space-y-0.5 text-xs text-fog">
                                        <li>
                                            1. <span className="break-all font-mono">{config.mapLookupUrl.trim()}</span> — fetched
                                            whole, no query parameter: what this athlete holds, and who holds the scanned code
                                        </li>
                                        <li>
                                            2. <span className="break-all font-mono">{config.participantApiUrl.trim() || "(participant endpoint)"}?bib=</span>
                                            <span className="font-mono text-hyred">11651</span> — the athlete&apos;s name, contest and slot
                                        </li>
                                    </ol>
                                </div>
                            )}
                        </div>

                        <div className="mt-6 grid gap-4 lg:grid-cols-2">
                            <div>
                                <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">Participant field mapping</label>
                                <textarea
                                    rows={6}
                                    value={config.participantMapping}
                                    onChange={(e) => setConfig({ ...config, participantMapping: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 font-mono text-xs outline-none focus:border-hyred"
                                />
                            </div>
                            <div>
                                <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">Update field mapping</label>
                                <textarea
                                    rows={6}
                                    value={config.updateMapping}
                                    onChange={(e) => setConfig({ ...config, updateMapping: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 font-mono text-xs outline-none focus:border-hyred"
                                />
                                <p className="mt-1 text-xs text-fog">
                                    Everything the check-in and judge apps write back. Keep the key on the left; put your RaceResult field
                                    name on the right. A key you leave out keeps its default name — an unknown key is rejected on save.
                                    To keep one value in two columns, give the key a list —{" "}
                                    <code>&quot;transponder1&quot;: [&quot;Transponder1&quot;, &quot;chipused&quot;]</code> — and both get
                                    written. Repeating the key twice does not work: the second one silently replaces the first. The first
                                    name in a list is the one read back.
                                </p>
                            </div>
                        </div>

                        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-fog">Check-in Window</h3>
                        <div className="space-y-3">
                            <label className="flex items-center gap-3 rounded-lg border border-smoke bg-coal px-3 py-2.5">
                                <input
                                    type="checkbox"
                                    checked={config.checkinWindowEnabled}
                                    onChange={(e) => setConfig({ ...config, checkinWindowEnabled: e.target.checked })}
                                    className="h-4 w-4"
                                />
                                <div>
                                    <p className="text-sm font-medium">Check athletes in only near their timeslot</p>
                                    <p className="text-xs text-fog">
                                        Off by default · With it off, any athlete can be checked in at any time
                                    </p>
                                </div>
                            </label>
                            {config.checkinWindowEnabled && (
                                <>
                                    <div className="grid gap-4 lg:grid-cols-2">
                                        <div>
                                            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">
                                                Opens · minutes before timeslot
                                            </label>
                                            <input
                                                type="number"
                                                min={0}
                                                max={10080}
                                                step={15}
                                                value={config.checkinOpensBeforeMinutes}
                                                onChange={(e) =>
                                                    setConfig({ ...config, checkinOpensBeforeMinutes: Number(e.target.value) })
                                                }
                                                className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm outline-none focus:border-hyred"
                                            />
                                            <p className="mt-1 text-xs text-fog">
                                                {durationLabel(config.checkinOpensBeforeMinutes)} before · a 04:00 slot opens at{" "}
                                                {slotPreview(config.checkinOpensBeforeMinutes)}
                                            </p>
                                        </div>
                                        <div>
                                            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">
                                                Closes · minutes after timeslot
                                            </label>
                                            <input
                                                type="number"
                                                min={0}
                                                max={10080}
                                                step={15}
                                                placeholder="Leave empty — never closes"
                                                value={config.checkinClosesAfterMinutes ?? ""}
                                                onChange={(e) =>
                                                    setConfig({
                                                        ...config,
                                                        checkinClosesAfterMinutes: e.target.value === "" ? null : Number(e.target.value),
                                                    })
                                                }
                                                className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm outline-none focus:border-hyred"
                                            />
                                            <p className="mt-1 text-xs text-fog">
                                                {config.checkinClosesAfterMinutes === null
                                                    ? "Never closes · a late athlete is still checked in"
                                                    : `${durationLabel(config.checkinClosesAfterMinutes)} after the slot, then the counter refuses`}
                                            </p>
                                        </div>
                                    </div>
                                    <p className="text-xs text-fog">
                                        Each athlete&apos;s window comes from their own <b>timeslot</b> and <b>contest date</b> on the
                                        roster — set them on the Athletes screen, or import them (RaceResult&apos;s{" "}
                                        <span className="font-mono">ContestDate</span> is read automatically). An entry with no contest
                                        date races on the event&apos;s own date; one whose timeslot names no clock time
                                        (&ldquo;Slot 3&rdquo;, or blank) is never refused. Event admins can always check anyone in,
                                        whatever the window says.
                                    </p>
                                </>
                            )}
                        </div>

                        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-fog">Stage 1 Declaration</h3>
                        <div className="space-y-3">
                            <div>
                                <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-fog">Declaration text</label>
                                <textarea
                                    rows={2}
                                    value={config.declarationText}
                                    onChange={(e) => setConfig({ ...config, declarationText: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-coal px-3 py-2.5 text-sm outline-none focus:border-hyred"
                                />
                                <p className="mt-1 text-xs text-fog">
                                    Read to the athlete at the wristband counter. The volunteer confirms the Government ID check and this
                                    declaration before a band can be issued; neither is stored — only the check-in itself goes to RaceResult.
                                </p>
                            </div>
                        </div>

                        <button onClick={saveConfig} className="mt-4 rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill">
                            Save &amp; Publish Configuration
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
