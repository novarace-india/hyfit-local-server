"use client";
import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { judgeApi, type JudgeUser } from "../../../../../lib/api";
import { Spinner, ErrorNote } from "../../../../../lib/ui";
import { FieldSignIn, useFieldSession } from "../../../../../lib/field-session";
import EventPicker from "../event-picker";

// Field ops has two jobs: judge a station, or staff a check-in counter. This
// screen hires for exactly those two. Console operators (event_admin, readonly)
// are not field staff and are not created here.
const ROLES = [
    { value: "judge", label: "Judge" },
    { value: "checkin", label: "Check-in Volunteer" },
] as const;

const STAGES = [
    { value: "STAGE_1_WRISTBAND", label: "Stage 1 · Check-In & Wristband", short: "Stage 1" },
    { value: "STAGE_2_TRANSPONDER", label: "Stage 2 · Arena Transponder", short: "Stage 2" },
] as const;

type CsvStaffRecord = {
    staffId: string;
    name?: string;
    pin: string;
    role: string;
    stationNumber?: number;
    checkinStage?: string;
};

const blankUser = { staffId: "", name: "", pin: "", role: "judge", stationNumber: "", checkinStage: "STAGE_1_WRISTBAND" };

export default function TeamPage() {
    const { id: eventId } = useParams<{ id: string }>();
    const scoped = (path: string) => `${path}${path.includes("?") ? "&" : "?"}eventId=${encodeURIComponent(eventId)}`;
    const { user, ready } = useFieldSession();
    const [users, setUsers] = useState<JudgeUser[]>([]);

    // Creation forms
    const [onboardTab, setOnboardTab] = useState<"manual" | "csv">("manual");
    const [newUser, setNewUser] = useState({ ...blankUser });

    // CSV Upload State
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [csvFile, setCsvFile] = useState<File | null>(null);
    const [csvRecords, setCsvRecords] = useState<CsvStaffRecord[]>([]);
    const [csvParseError, setCsvParseError] = useState("");
    const [csvBatchResult, setCsvBatchResult] = useState<{ created: number; total: number; errors: string[] } | null>(null);

    // User Search & Filters
    const [userSearch, setUserSearch] = useState("");
    const [userRoleFilter, setUserRoleFilter] = useState("all");
    const [userStatusFilter, setUserStatusFilter] = useState("all");

    const [editingUser, setEditingUser] = useState<{
        id: string;
        staffId: string;
        name: string;
        role: string;
        stationNumber: string;
        checkinStage: string;
        pin: string;
        enabled: boolean;
    } | null>(null);

    const [deletingUser, setDeletingUser] = useState<JudgeUser | null>(null);

    const [msg, setMsg] = useState("");
    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const userData = await judgeApi<{ users: JudgeUser[] }>(scoped("/admin/users"));
            setUsers(userData.users ?? []);
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setLoading(false);
        }
    }, [eventId]);

    useEffect(() => {
        setNewUser({ ...blankUser });
        setUserSearch("");
        setUserRoleFilter("all");
        setUserStatusFilter("all");
        setEditingUser(null);
        setDeletingUser(null);
        setCsvFile(null);
        setCsvRecords([]);
        setCsvParseError("");
        setCsvBatchResult(null);
        setMsg("");
        setErr("");
    }, [eventId]);

    useEffect(() => {
        if (user) void load();
        else if (ready) setLoading(false);
    }, [user, ready, load]);

    const showMsg = (text: string) => {
        setMsg(text);
        setTimeout(() => setMsg(""), 3000);
    };

    // CSV Sample Download
    const downloadSampleCsv = () => {
        const csvContent = `staffId,name,pin,role,stationNumber,checkinStage\nSTF-101,John Doe,1234,judge,1,\nSTF-102,,5678,checkin,,STAGE_1_WRISTBAND\nSTF-103,Asha Rao,4321,checkin,,STAGE_2_TRANSPONDER`;
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.setAttribute("download", "sample_staff_onboard.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    // Parse CSV File
    const handleCsvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setCsvParseError("");
        setCsvBatchResult(null);
        const file = e.target.files?.[0];
        if (!file) return;

        setCsvFile(file);
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                if (!text) throw new Error("File is empty");

                const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                if (lines.length < 2) throw new Error("CSV file must contain a header and at least one record row.");

                const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
                const staffIdIdx = headers.findIndex((h) => h === "staffid" || h === "id");
                const nameIdx = headers.findIndex((h) => h === "name" || h === "fullname");
                const pinIdx = headers.findIndex((h) => h === "pin" || h === "passcode");
                const roleIdx = headers.findIndex((h) => h === "role" || h === "type");
                const stationIdx = headers.findIndex((h) => h === "stationnumber" || h === "station" || h === "segment");
                const stageIdx = headers.findIndex((h) => h === "checkinstage" || h === "stage" || h === "stagetype");

                if (staffIdIdx === -1 || pinIdx === -1) {
                    throw new Error("CSV header must include at least 'staffId' and 'pin' columns.");
                }

                const records: CsvStaffRecord[] = [];
                for (let i = 1; i < lines.length; i++) {
                    const cols = lines[i].split(",").map((c) => c.trim().replace(/^["']|["']$/g, ""));
                    const staffId = cols[staffIdIdx] || "";
                    const pin = cols[pinIdx] || "";
                    if (!staffId && !pin) continue;

                    const name = nameIdx !== -1 && cols[nameIdx] ? cols[nameIdx] : undefined;
                    const role = roleIdx !== -1 && cols[roleIdx] ? cols[roleIdx] : "judge";
                    const stationRaw = stationIdx !== -1 ? cols[stationIdx] : "";
                    const stationNumber = stationRaw && !isNaN(Number(stationRaw)) ? Number(stationRaw) : undefined;
                    // A short form is accepted because nobody types
                    // STAGE_2_TRANSPONDER into a spreadsheet by choice.
                    const stageRaw = (stageIdx !== -1 ? cols[stageIdx] : "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                    const checkinStage =
                        stageRaw.includes("2") || stageRaw.includes("TRANSPONDER")
                            ? "STAGE_2_TRANSPONDER"
                            : stageRaw
                              ? "STAGE_1_WRISTBAND"
                              : undefined;

                    records.push({ staffId, name, pin, role, stationNumber, checkinStage });
                }

                if (records.length === 0) throw new Error("No valid staff records found in CSV file.");
                setCsvRecords(records);
            } catch (err: any) {
                setCsvParseError(err.message);
                setCsvRecords([]);
            }
        };
        reader.readAsText(file);
    };

    // Submit CSV Batch
    const handleUploadCsvBatch = async () => {
        if (csvRecords.length === 0) return;
        setErr("");
        setSubmitting(true);
        try {
            const res = await judgeApi<{ created: number; total: number; errors: string[] }>("/admin/users/batch", {
                method: "POST",
                body: JSON.stringify({ users: csvRecords, eventId }),
            });
            setCsvBatchResult(res);
            if (res.created > 0) {
                showMsg(`Onboarded ${res.created} of ${res.total} staff members from CSV`);
                await load();
            }
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setSubmitting(false);
        }
    };

    // Single User Creation
    const createUser = async () => {
        setErr("");
        try {
            await judgeApi("/admin/users", {
                method: "POST",
                body: JSON.stringify({
                    staffId: newUser.staffId,
                    name: newUser.name.trim() || undefined,
                    pin: newUser.pin,
                    role: newUser.role,
                    stationNumber: Number(newUser.stationNumber) || null,
                    // A judge staffs no counter, so the stage travels only with
                    // the role that uses it.
                    checkinStage: newUser.role === "checkin" ? newUser.checkinStage : null,
                    eventId,
                }),
            });
            setNewUser({ ...blankUser });
            showMsg("Team member onboarded successfully");
            await load();
        } catch (e: any) {
            setErr(e.message);
        }
    };

    const handleUpdateUser = async () => {
        if (!editingUser) return;
        setErr("");
        setSubmitting(true);
        try {
            await judgeApi("/admin/users", {
                method: "PATCH",
                body: JSON.stringify({
                    id: editingUser.id,
                    staffId: editingUser.staffId,
                    name: editingUser.name.trim() || editingUser.staffId,
                    role: editingUser.role,
                    stationNumber: editingUser.stationNumber.trim() !== "" ? Number(editingUser.stationNumber) : null,
                    checkinStage: editingUser.role === "checkin" ? editingUser.checkinStage : null,
                    pin: editingUser.pin.trim() ? editingUser.pin.trim() : undefined,
                    enabled: editingUser.enabled,
                    eventId,
                }),
            });
            setEditingUser(null);
            showMsg("Team member updated successfully");
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setSubmitting(false);
        }
    };

    const toggleUserStatus = async (u: JudgeUser) => {
        setErr("");
        try {
            await judgeApi("/admin/users", {
                method: "PATCH",
                body: JSON.stringify({ id: u.id, enabled: !u.enabled, eventId }),
            });
            showMsg(`${u.name ?? u.staffId} is now ${!u.enabled ? "enabled" : "disabled"}`);
            await load();
        } catch (e: any) {
            setErr(e.message);
        }
    };

    const handleDeleteUser = async () => {
        if (!deletingUser) return;
        setErr("");
        setSubmitting(true);
        try {
            const res = await judgeApi<{ ok: boolean; softDeleted?: boolean; message?: string }>(
                scoped(`/admin/users/${deletingUser.id}`),
                { method: "DELETE" }
            );
            setDeletingUser(null);
            showMsg(res.softDeleted ? (res.message || "Account disabled (has audit records)") : "Team member removed");
            await load();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setSubmitting(false);
        }
    };

    const stageShort = (stage?: string | null) => STAGES.find((s) => s.value === stage)?.short ?? null;

    const counts = useMemo(() => {
        const enabled = users.filter((u) => u.enabled);
        return {
            judges: enabled.filter((u) => u.role === "judge").length,
            stage1: enabled.filter((u) => u.role === "checkin" && u.checkinStage === "STAGE_1_WRISTBAND").length,
            stage2: enabled.filter((u) => u.role === "checkin" && u.checkinStage === "STAGE_2_TRANSPONDER").length,
            unstaged: enabled.filter((u) => u.role === "checkin" && !u.checkinStage).length,
        };
    }, [users]);

    const filteredUsers = useMemo(() => {
        return users.filter((u) => {
            const q = userSearch.toLowerCase().trim();
            const nameStr = (u.name ?? "").toLowerCase();
            const staffIdStr = (u.staffId ?? "").toLowerCase();
            const stationStr = u.stationNumber ? String(u.stationNumber) : "";
            const roleStr = (u.role ?? "").toLowerCase();

            const matchesSearch =
                !q ||
                nameStr.includes(q) ||
                staffIdStr.includes(q) ||
                stationStr.includes(q) ||
                roleStr.includes(q);

            const matchesRole =
                userRoleFilter === "all" ||
                (userRoleFilter === "STAGE_1_WRISTBAND" || userRoleFilter === "STAGE_2_TRANSPONDER"
                    ? u.role === "checkin" && u.checkinStage === userRoleFilter
                    : u.role === userRoleFilter);
            const matchesStatus =
                userStatusFilter === "all" ||
                (userStatusFilter === "enabled" && u.enabled) ||
                (userStatusFilter === "disabled" && !u.enabled);

            return matchesSearch && matchesRole && matchesStatus;
        });
    }, [users, userSearch, userRoleFilter, userStatusFilter]);

    if (!ready || (loading && user)) return <Spinner />;

    if (!user) {
        return (
            <div>
                <h1 className="text-2xl font-black uppercase tracking-wide">Team</h1>
                <p className="mt-1 text-sm text-fog">Judges and check-in volunteers for this event</p>
                <FieldSignIn what="team management" />
            </div>
        );
    }

    const roleLabel = (role: string) => {
        const labels: Record<string, string> = { judge: "Judge", checkin: "Check-in Volunteer", event_admin: "Event Admin", super_admin: "Super Admin", readonly: "Read-only" };
        return labels[role] || role;
    };

    const roleBadgeClass = (role: string) => {
        switch (role) {
            case "judge":
                return "bg-purple-950/60 text-purple-300 border-purple-800/40";
            case "checkin":
                return "bg-blue-950/60 text-blue-300 border-blue-800/40";
            case "event_admin":
            case "super_admin":
                return "bg-amber-950/60 text-amber-300 border-amber-800/40";
            default:
                return "bg-slate-800 text-slate-300 border-slate-700";
        }
    };

    const stat = (label: string, value: number, tone: string) => (
        <div className="rounded-lg border border-smoke/50 bg-ink px-3 py-2">
            <p className="text-[11px] uppercase font-bold tracking-wider text-fog">{label}</p>
            <p className={`text-xl font-black ${tone}`}>{value}</p>
        </div>
    );

    return (
        <div className="space-y-6">
            <div>
                <Link href={`/hyfitgames/admin/events/${eventId}`} className="text-xs font-bold uppercase tracking-widest text-fog hover:text-chalk">
                    ← Back to event
                </Link>
                <h1 className="mt-2 text-2xl font-black uppercase tracking-wide">Judges & Check-in Volunteers</h1>
                <p className="mt-1 text-sm text-fog">
                    Issue staff IDs and PINs for the field apps. A check-in volunteer signs in at the stage set here; everything they record goes straight to RaceResult.
                </p>
                <EventPicker eventId={eventId} segment="team" />

                {msg && <div className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-sm text-good font-medium">{msg}</div>}
                <ErrorNote msg={err} />
            </div>

            <div className="grid gap-2 sm:grid-cols-4">
                {stat("Judges", counts.judges, "text-purple-300")}
                {stat("Stage 1 · Wristband", counts.stage1, "text-blue-300")}
                {stat("Stage 2 · Transponder", counts.stage2, "text-blue-300")}
                {stat("No stage set", counts.unstaged, counts.unstaged ? "text-warn" : "text-fog")}
            </div>

            {/* Onboard staff card with Manual & CSV Tabs */}
            <div className="rounded-xl border border-smoke bg-coal p-5 shadow-sm">
                <div className="flex items-center justify-between border-b border-smoke/40 pb-3">
                    <div>
                        <h2 className="text-sm font-bold uppercase tracking-wide text-chalk">Onboard Staff</h2>
                        <p className="text-xs text-fog">Single entry or bulk CSV upload</p>
                    </div>
                    <div className="flex items-center gap-1 rounded-lg bg-ink p-1 border border-smoke/50">
                        <button
                            onClick={() => setOnboardTab("manual")}
                            className={`rounded px-2.5 py-1 text-xs font-bold transition-colors ${
                                onboardTab === "manual" ? "bg-hyred text-onfill" : "text-fog hover:text-chalk"
                            }`}
                        >
                            Manual
                        </button>
                        <button
                            onClick={() => setOnboardTab("csv")}
                            className={`rounded px-2.5 py-1 text-xs font-bold transition-colors ${
                                onboardTab === "csv" ? "bg-hyred text-onfill" : "text-fog hover:text-chalk"
                            }`}
                        >
                            Upload CSV
                        </button>
                    </div>
                </div>

                {onboardTab === "manual" ? (
                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                        <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                                <input
                                    placeholder="Staff ID (e.g. STF-01) *"
                                    value={newUser.staffId ?? ""}
                                    onChange={(e) => setNewUser({ ...newUser, staffId: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                />
                                <input
                                    placeholder="Full name (Optional)"
                                    value={newUser.name ?? ""}
                                    onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <input
                                    placeholder="PIN (4–8 digits) *"
                                    inputMode="numeric"
                                    value={newUser.pin ?? ""}
                                    onChange={(e) => setNewUser({ ...newUser, pin: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                />
                                <select
                                    value={newUser.role ?? "judge"}
                                    onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                >
                                    {ROLES.map((r) => (
                                        <option key={r.value} value={r.value}>{r.label}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="space-y-3">
                            {newUser.role === "checkin" ? (
                                <div>
                                    <label className="text-xs font-semibold text-fog">Check-in stage *</label>
                                    <select
                                        value={newUser.checkinStage}
                                        onChange={(e) => setNewUser({ ...newUser, checkinStage: e.target.value })}
                                        className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                    >
                                        {STAGES.map((s) => (
                                            <option key={s.value} value={s.value}>{s.label}</option>
                                        ))}
                                    </select>
                                    <p className="mt-1 text-[11px] text-fog">
                                        The stage they open when they sign in to the check-in app. There are no
                                        named counters to assign — this is the whole assignment.
                                    </p>
                                </div>
                            ) : (
                                <div>
                                    <label className="text-xs font-semibold text-fog">Station/Segment number (Optional)</label>
                                    <input
                                        placeholder="e.g. 1, 2, 3"
                                        value={newUser.stationNumber ?? ""}
                                        onChange={(e) => setNewUser({ ...newUser, stationNumber: e.target.value })}
                                        className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                    />
                                    <p className="mt-1 text-[11px] text-fog">Which race station this judge is posted to.</p>
                                </div>
                            )}
                            <button onClick={createUser} className="w-full rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill hover:bg-hyred/90 transition-colors">
                                + Create Account
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="mt-4 space-y-3">
                        <div className="flex items-center justify-between rounded-lg bg-ink p-3 border border-smoke/40">
                            <div>
                                <p className="text-xs font-bold text-chalk">Sample File Template</p>
                                <p className="text-[11px] text-fog">Contains 3 sample records with optional fields</p>
                            </div>
                            <button
                                onClick={downloadSampleCsv}
                                className="rounded border border-smoke bg-coal px-3 py-1.5 text-xs font-bold text-chalk hover:bg-smoke/30 transition-colors inline-flex items-center gap-1.5"
                            >
                                <span>📥</span>
                                <span>Download Sample CSV</span>
                            </button>
                        </div>

                        <div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".csv"
                                onChange={handleCsvFileChange}
                                className="hidden"
                            />
                            <div
                                onClick={() => fileInputRef.current?.click()}
                                className="cursor-pointer border-2 border-dashed border-smoke/60 hover:border-hyred/60 rounded-xl p-4 text-center transition-colors bg-ink/50"
                            >
                                <p className="text-xs font-bold text-chalk">
                                    {csvFile ? `Selected File: ${csvFile.name}` : "Click to select CSV file"}
                                </p>
                                <p className="text-[11px] text-fog mt-1">Columns: staffId, name (optional), pin, role (judge · checkin), stationNumber (optional), checkinStage (optional)</p>
                            </div>
                        </div>

                        {csvParseError && <div className="text-xs text-bad bg-bad/10 p-2 rounded border border-bad/30">{csvParseError}</div>}

                        {csvRecords.length > 0 && (
                            <div>
                                <p className="text-xs font-bold text-good mb-1.5">Parsed {csvRecords.length} records ready for upload:</p>
                                <div className="max-h-32 overflow-y-auto rounded border border-smoke/40 bg-ink p-2 space-y-1 text-xs">
                                    {csvRecords.map((r, idx) => (
                                        <div key={idx} className="flex items-center justify-between text-[11px] font-mono border-b border-smoke/20 pb-1">
                                            <span className="text-chalk font-bold">{r.staffId}</span>
                                            <span className="text-fog">{r.name || "(No Name)"}</span>
                                            <span className="text-hyred">{r.role}</span>
                                            <span className="text-fog">{r.role === "checkin" ? (stageShort(r.checkinStage) ?? "Stage 1") : "—"}</span>
                                            <span className="text-fog">PIN: {r.pin}</span>
                                        </div>
                                    ))}
                                </div>
                                <button
                                    onClick={handleUploadCsvBatch}
                                    disabled={submitting}
                                    className="mt-3 w-full rounded-lg bg-hyred px-4 py-2 text-sm font-bold uppercase tracking-wide text-onfill hover:bg-hyred/90 transition-colors disabled:opacity-50"
                                >
                                    {submitting ? "Uploading Staff..." : `🚀 Upload ${csvRecords.length} Staff Members`}
                                </button>
                            </div>
                        )}

                        {csvBatchResult && (
                            <div className="mt-2 rounded bg-ink p-3 border border-smoke/40 text-xs space-y-1">
                                <p className="font-bold text-good">
                                    Result: {csvBatchResult.created} of {csvBatchResult.total} staff members onboarded.
                                </p>
                                {csvBatchResult.errors.length > 0 && (
                                    <div className="mt-1 space-y-0.5 max-h-24 overflow-y-auto text-bad font-mono text-[11px]">
                                        {csvBatchResult.errors.map((errStr, idx) => (
                                            <p key={idx}>{errStr}</p>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* TEAM ROSTER SECTION */}
            <div className="rounded-xl border border-smoke bg-coal p-5 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-smoke/40 pb-4">
                    <div>
                        <h2 className="text-base font-bold uppercase tracking-wide text-chalk flex items-center gap-2">
                            <span>Team Roster</span>
                            <span className="rounded-full bg-hyred/20 px-2 py-0.5 text-xs font-extrabold text-hyred border border-hyred/30">
                                {filteredUsers.length} / {users.length}
                            </span>
                        </h2>
                        <p className="text-xs text-fog mt-0.5">Search and manage judges and check-in volunteers</p>
                    </div>

                    {/* Search & Filter Bar */}
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Search name, ID, station..."
                                value={userSearch ?? ""}
                                onChange={(e) => setUserSearch(e.target.value)}
                                className="w-44 sm:w-60 rounded-lg border border-smoke bg-ink pl-8 pr-7 py-1.5 text-xs outline-none focus:border-hyred"
                            />
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-fog">🔍</span>
                            {userSearch && (
                                <button
                                    onClick={() => setUserSearch("")}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-fog hover:text-chalk"
                                >
                                    ✕
                                </button>
                            )}
                        </div>

                        <select
                            value={userRoleFilter ?? "all"}
                            onChange={(e) => setUserRoleFilter(e.target.value)}
                            className="rounded-lg border border-smoke bg-ink px-2.5 py-1.5 text-xs outline-none focus:border-hyred"
                        >
                            <option value="all">All Roles</option>
                            <option value="judge">Judge</option>
                            <option value="checkin">Check-in Volunteer</option>
                            <option value="STAGE_1_WRISTBAND">— Stage 1 only</option>
                            <option value="STAGE_2_TRANSPONDER">— Stage 2 only</option>
                        </select>

                        <select
                            value={userStatusFilter ?? "all"}
                            onChange={(e) => setUserStatusFilter(e.target.value)}
                            className="rounded-lg border border-smoke bg-ink px-2.5 py-1.5 text-xs outline-none focus:border-hyred"
                        >
                            <option value="all">All Status</option>
                            <option value="enabled">Active</option>
                            <option value="disabled">Disabled</option>
                        </select>
                    </div>
                </div>

                <div className="mt-4 max-h-[460px] overflow-y-auto pr-1">
                    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                        {filteredUsers.map((u) => (
                            <div
                                key={u.id}
                                className={`flex flex-col justify-between rounded-lg border p-3.5 transition-all ${
                                    u.enabled ? "border-smoke/60 bg-ink hover:border-smoke" : "border-smoke/30 bg-ink/40 opacity-70"
                                }`}
                            >
                                <div>
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-bold truncate text-chalk">{u.name || u.staffId || "Staff Member"}</p>
                                            <p className="text-xs font-mono text-fog mt-0.5">{u.staffId || "No Staff ID"}</p>
                                        </div>
                                        <span
                                            className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold rounded border ${roleBadgeClass(
                                                u.role
                                            )}`}
                                        >
                                            {roleLabel(u.role)}
                                        </span>
                                    </div>

                                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                        {u.role === "judge" && u.stationNumber && (
                                            <span className="inline-flex items-center gap-1 rounded bg-purple-950/40 border border-purple-800/30 px-2 py-0.5 text-[11px] text-purple-200">
                                                <span>Station/Segment:</span>
                                                <span className="font-bold font-mono text-purple-300">#{u.stationNumber}</span>
                                            </span>
                                        )}

                                        {u.role === "checkin" && (
                                            stageShort(u.checkinStage) ? (
                                                // "Stage", not "Counter": there is no counter to be
                                                // at any more — the stage on the volunteer IS the
                                                // assignment, and calling it a counter sent people
                                                // looking for one in the volunteer app.
                                                <span className="inline-flex items-center gap-1 rounded bg-blue-950/40 border border-blue-800/30 px-2 py-0.5 text-[11px] text-blue-200">
                                                    <span>Stage:</span>
                                                    <span className="font-bold text-blue-300">{stageShort(u.checkinStage)}</span>
                                                </span>
                                            ) : (
                                                // A volunteer with no stage can sign in and do nothing, so
                                                // it is called out rather than left as a blank.
                                                <span className="inline-flex items-center gap-1 rounded bg-warn/10 border border-warn/30 px-2 py-0.5 text-[11px] text-warn font-bold">
                                                    No stage set
                                                </span>
                                            )
                                        )}
                                    </div>
                                </div>

                                <div className="mt-3 flex items-center justify-between border-t border-smoke/30 pt-2 text-xs">
                                    <button
                                        onClick={() => toggleUserStatus(u)}
                                        className={`inline-flex items-center gap-1 font-bold ${
                                            u.enabled ? "text-good hover:text-good/80" : "text-warn hover:text-warn/80"
                                        }`}
                                    >
                                        <span className={`h-2 w-2 rounded-full ${u.enabled ? "bg-good" : "bg-warn"}`} />
                                        {u.enabled ? "Active" : "Disabled"}
                                    </button>

                                    <div className="flex items-center gap-1.5">
                                        <button
                                            onClick={() =>
                                                setEditingUser({
                                                    id: u.id,
                                                    staffId: u.staffId ?? "",
                                                    name: u.name ?? "",
                                                    role: u.role ?? "judge",
                                                    stationNumber: u.stationNumber ? String(u.stationNumber) : "",
                                                    checkinStage: u.checkinStage ?? "STAGE_1_WRISTBAND",
                                                    pin: "",
                                                    enabled: !!u.enabled,
                                                })
                                            }
                                            className="rounded border border-smoke px-2 py-0.5 text-fog hover:bg-smoke/30 hover:text-chalk"
                                        >
                                            Edit
                                        </button>
                                        <button
                                            onClick={() => setDeletingUser(u)}
                                            className="rounded border border-bad/30 px-2 py-0.5 text-bad hover:bg-bad/10"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {filteredUsers.length === 0 && (
                        <div className="py-10 text-center text-sm text-fog border border-dashed border-smoke/40 rounded-lg">
                            {users.length === 0 ? "No team members onboarded yet." : "No team members match the search filters."}
                        </div>
                    )}
                </div>
            </div>

            {/* EDIT USER MODAL */}
            {editingUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-xl border border-smoke bg-coal p-6 shadow-2xl">
                        <div className="flex items-center justify-between border-b border-smoke/40 pb-3">
                            <h3 className="text-base font-bold uppercase tracking-wide text-chalk">Edit Team Member</h3>
                            <button onClick={() => setEditingUser(null)} className="text-fog hover:text-chalk">
                                ✕
                            </button>
                        </div>

                        <div className="mt-4 space-y-3">
                            <div>
                                <label className="text-xs font-semibold text-fog">Staff ID *</label>
                                <input
                                    value={editingUser.staffId ?? ""}
                                    onChange={(e) => setEditingUser({ ...editingUser, staffId: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-fog">Full Name (Optional)</label>
                                <input
                                    value={editingUser.name ?? ""}
                                    onChange={(e) => setEditingUser({ ...editingUser, name: e.target.value })}
                                    placeholder="Leave blank to use Staff ID as name"
                                    className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-fog">Role</label>
                                <select
                                    value={editingUser.role ?? "judge"}
                                    onChange={(e) => setEditingUser({ ...editingUser, role: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                >
                                    {ROLES.map((r) => (
                                        <option key={r.value} value={r.value}>{r.label}</option>
                                    ))}
                                    {/* A console account edited here keeps its own role rather than
                                        being silently demoted to judge by the dropdown's first option. */}
                                    {!ROLES.some((r) => r.value === editingUser.role) && (
                                        <option value={editingUser.role}>{roleLabel(editingUser.role)}</option>
                                    )}
                                </select>
                            </div>
                            {editingUser.role === "checkin" ? (
                                <div>
                                    <label className="text-xs font-semibold text-fog">Check-in stage *</label>
                                    <select
                                        value={editingUser.checkinStage}
                                        onChange={(e) => setEditingUser({ ...editingUser, checkinStage: e.target.value })}
                                        className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                    >
                                        {STAGES.map((s) => (
                                            <option key={s.value} value={s.value}>{s.label}</option>
                                        ))}
                                    </select>
                                </div>
                            ) : (
                                <div>
                                    <label className="text-xs font-semibold text-fog">Station/Segment Number (Optional)</label>
                                    <input
                                        value={editingUser.stationNumber ?? ""}
                                        onChange={(e) => setEditingUser({ ...editingUser, stationNumber: e.target.value })}
                                        placeholder="Leave blank to unassign station"
                                        className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                    />
                                </div>
                            )}
                            <div>
                                <label className="text-xs font-semibold text-fog">Reset PIN (Optional, 4–8 digits)</label>
                                <input
                                    placeholder="Leave empty to keep existing PIN"
                                    inputMode="numeric"
                                    value={editingUser.pin ?? ""}
                                    onChange={(e) => setEditingUser({ ...editingUser, pin: e.target.value })}
                                    className="w-full rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
                                />
                            </div>
                            <div className="flex items-center gap-2 pt-1">
                                <input
                                    type="checkbox"
                                    id="edit-user-enabled"
                                    checked={!!editingUser.enabled}
                                    onChange={(e) => setEditingUser({ ...editingUser, enabled: e.target.checked })}
                                    className="h-4 w-4 rounded border-smoke text-hyred focus:ring-hyred"
                                />
                                <label htmlFor="edit-user-enabled" className="text-sm font-medium text-chalk">
                                    Account Enabled
                                </label>
                            </div>
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-3 border-t border-smoke/40 pt-4">
                            <button
                                onClick={() => setEditingUser(null)}
                                className="rounded-lg border border-smoke px-4 py-2 text-xs font-bold uppercase text-fog hover:text-chalk"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleUpdateUser}
                                disabled={submitting}
                                className="rounded-lg bg-hyred px-4 py-2 text-xs font-bold uppercase text-onfill hover:bg-hyred/90 disabled:opacity-50"
                            >
                                {submitting ? "Saving..." : "Save Changes"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* DELETE USER CONFIRMATION MODAL */}
            {deletingUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-sm rounded-xl border border-smoke bg-coal p-6 shadow-2xl">
                        <h3 className="text-base font-bold uppercase tracking-wide text-bad">Remove Team Member?</h3>
                        <p className="mt-2 text-xs text-fog leading-relaxed">
                            Are you sure you want to remove <strong className="text-chalk">{deletingUser.name || deletingUser.staffId}</strong> ({deletingUser.staffId})?
                        </p>
                        <div className="mt-6 flex items-center justify-end gap-3">
                            <button
                                onClick={() => setDeletingUser(null)}
                                className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase text-fog hover:text-chalk"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDeleteUser}
                                disabled={submitting}
                                className="rounded-lg bg-bad px-4 py-1.5 text-xs font-bold uppercase text-onfill hover:bg-bad/90 disabled:opacity-50"
                            >
                                {submitting ? "Removing..." : "Delete Member"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
