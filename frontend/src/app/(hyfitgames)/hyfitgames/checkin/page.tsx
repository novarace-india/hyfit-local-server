"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import QrScanner from "../judge/components/qr-scanner";
import ThemeToggle from "../judge/components/theme-toggle";
import MobileActionDock from "../judge/components/mobile-action-dock";
import { isDoublesContestId } from "../judge/lib/doubles";

type StageType = "STAGE_1_WRISTBAND" | "STAGE_2_TRANSPONDER";
// What RaceResult holds for a stage. `completedAt` is already the event's local
// clock, so it is printed as it came rather than pushed through a Date.
type StageReceipt = { state: string; completedAt: string; assetCode: string };
type Person = { bib: string; name: string; gender: string; dateOfBirth: string; category: string; contestId: string; wave: string; timeslot: string; contestDate: string; club: string; wristbandCode: string; transponderCode: string };
// The counter's copy of the event's check-in window, decided for THIS athlete
// by the server. `off` and `no_slot` both mean "no window applies here" — the
// second because the entry's timeslot names no clock time.
type CheckinWindow = { state: "off"|"no_slot"|"early"|"open"|"late"; allowed: boolean; slotAt: string|null; opensAt: string|null; closesAt: string|null; message: string };
type ParticipantResult = { participant: Person; window: CheckinWindow; teammates: Array<Person & { stages: Record<string,string> }>; teamWarning: string | null; stages: Partial<Record<StageType,StageReceipt>> };
type CheckinContext = {
  volunteer: { id: string; staffId: string; name: string };
  stage: StageType | null;
  // Whether this event's RaceResult endpoints are set up, and whether its feed
  // publishes the stage status columns the counter reads back.
  integration: { configured: boolean; canWrite: boolean; publishesStageStatus: boolean };
  policy: { declarationText: string; declarationVersion: number };
};
type CompletionReceipt = { bib: string; state: string; completedAt: string; assetCode: string; stageType: StageType };

async function jsonApi(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? data.message ?? "Request failed");
  return data;
}

// Is a counter session open? Only a counter sign-in can answer yes. No other
// identity on this device is adopted — not the judge session, not an admin
// console token — because a counter is answerable for who handed which
// wristband to which athlete, and that name has to come from someone who
// signed in to do the job.
function counterSession() {
  return jsonApi("/api/hyfit-judge/checkin/auth/session");
}

function displayDate(value: string) {
  if (!value) return "Not provided";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export default function CheckinPage() {
  const [loggedIn, setLoggedIn] = useState(false);
  // The counter's session is an HttpOnly cookie valid for 12 hours, so a
  // reload does not end it — only this component's state. Until the server has
  // said whether it is still open, neither the sign-in card nor the counter is
  // the right thing to show.
  const [checkingSession, setCheckingSession] = useState(true);
  const [credentials, setCredentials] = useState({ staffId: "", pin: "" });
  const [context, setContext] = useState<CheckinContext | null>(null);
  const [result, setResult] = useState<ParticipantResult | null>(null);
  const [bib, setBib] = useState("");
  const [wristbandQuery, setWristbandQuery] = useState("");
  const [assetCode, setAssetCode] = useState("");
  const [idVerified, setIdVerified] = useState(false);
  const [declarationAccepted, setDeclarationAccepted] = useState(false);
  const [scanTarget, setScanTarget] = useState<"bib"|"wristband_search"|"asset"|null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<CompletionReceipt | null>(null);

  // Reopens the counter after a refresh instead of asking a volunteer to sign
  // in again mid-queue. Context is refetched rather than cached: the stage they
  // staff can have changed while the tab was closed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await counterSession();
        const assigned: CheckinContext = await jsonApi("/api/hyfit-judge/checkin/context");
        if (cancelled) return;
        setContext(assigned);
        setLoggedIn(true);
        setMessage(contextProblem(assigned));
      } catch {
        /* No session, or it expired: the sign-in card is the right answer. */
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Everything that stops this counter working, said once, at the top.
  function contextProblem(assigned: CheckinContext) {
    if (!assigned.stage) return "Admin must assign this volunteer to Stage 1 or Stage 2 before you can check anyone in.";
    if (!assigned.integration.configured) return "This event has no RaceResult participant endpoint. Ask an admin to set one in Operations.";
    if (!assigned.integration.canWrite) return "This event has no RaceResult update endpoint. Check-ins cannot be recorded until an admin sets one in Operations.";
    return "";
  }

  const stageType = context?.stage ?? null;
  const stageOne = stageType === "STAGE_1_WRISTBAND";
  const existing = stageType ? result?.stages[stageType] : null;
  // A closed window blocks both stages: the transponder desk is check-in too,
  // and letting Stage 2 through would put an athlete on the floor early by the
  // back door.
  const windowBlocked = result ? result.window.allowed === false : false;
  const canComplete = useMemo(() => {
    if (!result || !stageType || !assetCode.trim() || existing) return false;
    if (result.window.allowed === false) return false;
    if (!stageOne) return Boolean(result.stages.STAGE_1_WRISTBAND);
    return idVerified && declarationAccepted;
  }, [result, stageType, assetCode, existing, stageOne, idVerified, declarationAccepted]);

  async function signIn() {
    try {
      await jsonApi("/api/hyfit-judge/checkin/auth/login", { method: "POST", body: JSON.stringify({ ...credentials, deviceLabel: navigator.userAgent }) });
      const assigned: CheckinContext = await jsonApi("/api/hyfit-judge/checkin/context");
      setContext(assigned); setLoggedIn(true);
      setMessage(contextProblem(assigned));
    } catch (error) { setMessage((error as Error).message); }
  }
  // Ends the counter's shift and nothing else: the judge session that may be
  // signed in on this same tablet keeps its own cookie and its own race.
  async function signOut() {
    try {
      await jsonApi("/api/hyfit-judge/checkin/auth/logout", { method: "POST" });
    } catch { /* Already gone server-side is the same outcome as signing out. */ }
    setLoggedIn(false); setContext(null); setCredentials({ staffId: "", pin: "" });
    reset();
  }
  async function findBib(value = bib) {
    try {
      const data = await jsonApi(`/api/hyfit-judge/checkin/participant?bib=${encodeURIComponent(value.trim())}`);
      setResult(data); setBib(value); setMessage(""); setReceipt(null);
    } catch (error) { setMessage((error as Error).message); }
  }
  async function findWristband(value = wristbandQuery) {
    try {
      const data = await jsonApi(`/api/hyfit-judge/checkin/participant?wristband=${encodeURIComponent(value.trim())}`);
      setResult(data); setWristbandQuery(value); setMessage(""); setReceipt(null);
    } catch (error) { setMessage((error as Error).message); }
  }
  function scanned(value: string) {
    const clean = value.trim();
    if (!clean) return "QR code is empty";
    const target = scanTarget;
    if (target === "bib" && !/^\d+$/.test(clean)) return "Participant QR must contain a numeric BIB";
    setScanTarget(null);
    if (target === "bib") { setBib(clean); void findBib(clean); }
    else if (target === "wristband_search") { setWristbandQuery(clean); void findWristband(clean); }
    else setAssetCode(clean);
    return null;
  }
  async function complete() {
    if (!canComplete || !result || !stageType) return;
    setBusy(true); setMessage("");
    try {
      const completed = await jsonApi("/api/hyfit-judge/checkin/stage", {
        method: "POST",
        body: JSON.stringify({
          bib: result.participant.bib, stageType, assetCode: assetCode.trim(),
          governmentIdVerified: idVerified, verbalDeclarationAccepted: declarationAccepted,
        }),
      });
      setReceipt(completed);
    } catch (error) {
      // A failed write means the check-in did not happen. Nothing is queued, so
      // the honest instruction is to do it again.
      setMessage((error as Error).message);
    }
    finally { setBusy(false); }
  }
  function reset() {
    setResult(null); setBib(""); setWristbandQuery(""); setAssetCode(""); setIdVerified(false);
    setDeclarationAccepted(false); setReceipt(null); setMessage("");
  }

  if (checkingSession) return <main className="ops-login checkin-login"><div className="login-theme-corner"><ThemeToggle /></div><div className="ops-login-card"><Image src="/branding/hyfit-games-2026-white.svg" width={90} height={90} unoptimized alt="HYFIT"/><div className="ops-kicker">VOLUNTEER OPERATIONS</div><h1>Restoring your counter…</h1></div></main>;
  if (!loggedIn) return <main className="ops-login checkin-login"><div className="login-theme-corner"><ThemeToggle /></div><div className="ops-login-card"><Image src="/branding/hyfit-games-2026-white.svg" width={90} height={90} unoptimized alt="HYFIT"/><div className="ops-kicker">VOLUNTEER OPERATIONS</div><h1>Check-in sign in</h1><input placeholder="Staff ID" value={credentials.staffId} onChange={(event)=>setCredentials({...credentials,staffId:event.target.value})}/><input type="password" inputMode="numeric" placeholder="PIN" value={credentials.pin} onChange={(event)=>setCredentials({...credentials,pin:event.target.value})}/><button onClick={signIn}>Open my counter</button><p className="ops-signin-note">Use the staff ID and PIN issued for your counter shift. Judging signs in separately, in the judge app.</p>{message&&<p className="ops-error">{message}</p>}</div></main>;

  const stageLabel = stageOne ? "STAGE 1 · WRISTBAND" : stageType ? "STAGE 2 · TRANSPONDER" : "NO STAGE ASSIGNED";
  const participant = result?.participant;
  if (receipt) return <main className={`checkin-shell stage-shell ${stageOne ? "stage-one" : "stage-two"}`}>
    <header><Image src="/branding/hyfit-games-2026-white.svg" width={55} height={55} unoptimized alt="HYFIT"/><div><small>{stageLabel}</small><b>{context?.volunteer.name}</b></div><span className="ops-live">● RaceResult</span><ThemeToggle /><button className="checkin-signout" onClick={()=>void signOut()}>Sign out</button></header>
    <section className="stage-receipt"><div className="receipt-check">✓</div><small>{receipt.stageType === "STAGE_1_WRISTBAND" ? "WRISTBAND HANDED OVER" : "TRANSPONDER HANDED OVER"}</small><h1>BIB {receipt.bib}</h1><div className="receipt-asset"><span>{receipt.stageType === "STAGE_1_WRISTBAND" ? "WRISTBAND" : "TRANSPONDER1"}</span><b>{receipt.assetCode}</b></div><p>{receipt.completedAt} · Saved to RaceResult</p><button className="stage-primary" onClick={reset}>Next athlete</button></section>
  </main>;

  return <main className={`checkin-shell stage-shell ${stageOne ? "stage-one" : "stage-two"}`}>
    <header><Image src="/branding/hyfit-games-2026-white.svg" width={55} height={55} unoptimized alt="HYFIT"/><div><small>{stageLabel}</small><b>{context?.volunteer.name}</b></div><span className="ops-live">● RaceResult</span><ThemeToggle /><button className="checkin-signout" onClick={()=>void signOut()}>Sign out</button></header>
    <div className="stage-rail"><b>{stageOne ? "01" : "02"}</b><span>{stageOne ? "VERIFY → DECLARE → WRISTBAND" : "CHECK STAGE 1 → TRANSPONDER"}</span><small>{context?.volunteer.staffId} · {context?.volunteer.name}</small></div>
    <section className="checkin-content stage-content">
      {message&&<div className="ops-message">{message}<button onClick={()=>setMessage("")}>×</button></div>}
      {!participant ? (
        stageOne ? (
          <article className="scan-card stage-scan"><div className="scan-symbol">▦</div><small>{stageLabel}</small><h1>Scan athlete QR</h1><p>The QR should contain the athlete’s numeric BIB.</p><button className="stage-primary" disabled={!stageType} onClick={()=>setScanTarget("bib")}>Open camera scanner</button><div className="manual-line"><input inputMode="numeric" placeholder="Enter BIB manually" value={bib} onChange={(event)=>setBib(event.target.value)}/><button onClick={()=>void findBib()}>Find athlete</button></div></article>
        ) : (
          <article className="scan-card stage-scan"><div className="scan-symbol">▦</div><small>{stageLabel}</small><h1>Scan wristband QR</h1><p>Scan or enter the wristband ID assigned during Stage 1.</p><button className="stage-primary" disabled={!stageType} onClick={()=>setScanTarget("wristband_search")}>Open camera scanner</button><div className="manual-line"><input placeholder="Enter Wristband ID manually" value={wristbandQuery} onChange={(event)=>setWristbandQuery(event.target.value)}/><button onClick={()=>void findWristband()}>Find athlete</button></div></article>
        )
      )
      : <div className="stage-workspace">
        <section className="identity-column">
          <article className="identity-card">
            <div className="identity-top"><div><small>VERIFY ATHLETE</small><h1>{participant.name}</h1></div><strong><small>BIB</small>{participant.bib}</strong></div>
            <div className="identity-grid"><div><small>GENDER</small><b>{participant.gender || "Not provided"}</b></div><div><small>DATE OF BIRTH</small><b>{displayDate(participant.dateOfBirth)}</b></div><div><small>CONTEST</small><b>{participant.category}</b></div><div><small>WAVE TIME</small><b>{participant.wave || "—"}</b></div><div><small>TIMESLOT</small><b>{participant.timeslot || "Not assigned"}</b></div><div><small>CONTEST DATE</small><b>{participant.contestDate ? displayDate(participant.contestDate) : "Event date"}</b></div></div>
          </article>
          {/* Nothing is shown when no window applies: a counter that is always
              open should not carry a banner saying so. */}
          {result!.window.state !== "off" && result!.window.state !== "no_slot" &&
            <article className={`checkin-window-card ${result!.window.allowed ? "open" : "shut"}`}>
              <small>{result!.window.state === "early" ? "TOO EARLY" : result!.window.state === "late" ? "WINDOW CLOSED" : "WINDOW OPEN"}</small>
              <b>{result!.window.message}</b>
              {result!.window.opensAt && <span>Opens {new Date(result!.window.opensAt).toLocaleString()}{result!.window.closesAt ? ` · closes ${new Date(result!.window.closesAt).toLocaleString()}` : ""}</span>}
            </article>}
          {isDoublesContestId(participant.contestId) && <article className="team-card"><small>DOUBLES TEAM · {participant.club || "Team data needs attention"}</small>{result!.teammates.map((mate)=><div key={mate.bib}><span><b>{mate.name}</b><small>BIB {mate.bib} · {mate.gender} · {displayDate(mate.dateOfBirth)}</small></span><em>{mate.stages?.STAGE_2_TRANSPONDER ? "Stage 2 ✓" : mate.stages?.STAGE_1_WRISTBAND ? "Stage 1 ✓" : "Waiting"}</em></div>)}{result!.teamWarning&&<p>⚠ {result!.teamWarning}</p>}</article>}
          {!stageOne && result!.stages.STAGE_1_WRISTBAND && <article className="prior-stage-card"><small>STAGE 1 RECEIPT</small><b>Wristband {result!.stages.STAGE_1_WRISTBAND.assetCode}</b><span>{result!.stages.STAGE_1_WRISTBAND.completedAt || "Recorded in RaceResult"}</span></article>}
        </section>
        <section className="action-column">
          {existing ? <article className="already-done"><b>✓ {stageOne ? "Stage 1" : "Stage 2"} already complete</b><p>{existing.assetCode}{existing.completedAt ? ` · ${existing.completedAt}` : ""}</p><button className="stage-primary" onClick={reset}>Scan next athlete</button></article>
          : windowBlocked ? <article className="stage-blocked"><b>{result!.window.state === "early" ? "Outside this athlete's check-in window" : "This athlete's check-in window has closed"}</b><p>{result!.window.message}</p><button onClick={reset}>Scan another athlete</button></article>
          : stageOne ? <>
            <button className={`verify-button ${idVerified ? "confirmed" : ""}`} onClick={()=>setIdVerified(!idVerified)}><b>{idVerified ? "✓ ID verified" : "Government ID verified"}</b><span>Compare name, gender and date of birth</span></button>
            <article className="declaration-card"><small>PARTICIPANT DECLARATION</small><p>{context?.policy.declarationText}</p><label><input type="checkbox" checked={declarationAccepted} onChange={(event)=>setDeclarationAccepted(event.target.checked)}/><span>I confirm the athlete accepts this declaration</span></label></article>
            <button className="asset-scan-button" onClick={()=>setScanTarget("asset")}><small>WRISTBAND</small><b>{assetCode||"Scan wristband"}</b><span>{assetCode?"Tap to rescan":"Camera or manual entry"}</span></button>
          </> : !result!.stages.STAGE_1_WRISTBAND ? <article className="stage-blocked"><b>Stage 1 is not complete</b><p>Send the athlete to the Check-In and Wristband counter before assigning a transponder.</p><button onClick={reset}>Scan another athlete</button></article>
          : <button className="asset-scan-button transponder" onClick={()=>setScanTarget("asset")}><small>TRANSPONDER1</small><b>{assetCode||"Scan transponder"}</b><span>{assetCode?"Tap to rescan":"Camera or manual entry"}</span></button>}
          {!existing && !windowBlocked && (stageOne || result!.stages.STAGE_1_WRISTBAND) && <><div className="manual-asset"><input placeholder={`Enter ${stageOne?"wristband":"transponder"} code`} value={assetCode} onChange={(event)=>setAssetCode(event.target.value)}/></div><MobileActionDock><button className="stage-primary complete-stage" disabled={!canComplete||busy} onClick={()=>void complete()}>{busy?"Saving to RaceResult…":`Complete ${stageOne?"Stage 1":"Stage 2"}`}</button></MobileActionDock></>}
          <button className="checkin-reset" onClick={reset}>Cancel / change athlete</button>
        </section>
      </div>}
    </section>
    {scanTarget&&<QrScanner onClose={()=>setScanTarget(null)} onScan={scanned}/>}
  </main>;
}
