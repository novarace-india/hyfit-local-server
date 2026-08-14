"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import QrScanner from "../judge/components/qr-scanner";
import ThemeToggle from "../judge/components/theme-toggle";
import MobileActionDock from "../judge/components/mobile-action-dock";
import { isDoublesContestId } from "../judge/lib/doubles";

type StageType = "STAGE_1_WRISTBAND" | "STAGE_2_TRANSPONDER";
type Person = { bib: string; name: string; gender: string; dateOfBirth: string; category: string; contestId: string; wave: string; timeslot: string; contestDate: string; club: string; wristbandCode: string; transponderCode: string };
// What the mapping table says this athlete holds. The counter's authority on
// which stage is due, and the reason there are no longer Stage 1 and Stage 2
// desks: the athlete decides, one at a time.
type Assignment = { bib: string; wristband: string; transponder: string };
type Teammate = Person & { nextStage: StageType | null; wristbandIssued: boolean; transponderIssued: boolean };
// The counter's copy of the event's check-in window, decided for THIS athlete
// by the server. `off` and `no_slot` both mean "no window applies here" — the
// second because the entry's timeslot names no clock time.
type CheckinWindow = { state: "off"|"no_slot"|"early"|"open"|"late"; allowed: boolean; slotAt: string|null; opensAt: string|null; closesAt: string|null; message: string };
// No `stages`. The lookup says what the athlete holds and what is left to give
// them, and nothing else about equipment — one answer, from the mapping table.
type ParticipantResult = { participant: Person; window: CheckinWindow; assignment: Assignment; nextStage: StageType | null; teammates: Teammate[]; teamWarning: string | null };
type CheckinContext = {
  volunteer: { id: string; staffId: string; name: string };
  // The shift this volunteer was rostered onto, for the header to name. It does
  // not limit the counter: what is handed over is decided per athlete, by what
  // they already hold, so this is who is on duty and not what they may do.
  stage: StageType | null;
  // Whether this event's RaceResult endpoints are set up. The mapping table is
  // now as load-bearing as the participant feed — it is what says what an
  // athlete already holds — so its health is reported beside it.
  integration: { configured: boolean; canWrite: boolean; mappingConfigured: boolean; mappingReadable: boolean; publishesWristband: boolean; publishesTransponder: boolean };
  policy: { declarationText: string; declarationVersion: number };
};
type CompletionReceipt = { bib: string; state: string; completedAt: string; assetCode: string; stageType: StageType; nextStage: StageType | null };

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
  // in again mid-queue.
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
    const i = assigned.integration;
    if (!i.configured) return "This event has no RaceResult participant endpoint. Ask an admin to set one in Operations.";
    if (!i.mappingConfigured) return "This event has no RaceResult equipment mapping endpoint. It is what says which equipment an athlete already holds, so nothing can be checked in until an admin sets it in Operations.";
    if (!i.mappingReadable) return "The equipment mapping endpoint could not be read. Ask an admin to check it in Operations.";
    if (!i.publishesWristband) return "The equipment mapping table has no wristband column, so this counter cannot tell whether a band is already issued. Ask an admin to fix the mapping in Operations.";
    if (!i.publishesTransponder) return "The equipment mapping table has no transponder column, so this counter cannot tell whether a transponder is already issued. Ask an admin to fix the mapping in Operations.";
    if (!i.canWrite) return "This event has no RaceResult update endpoint. Check-ins cannot be recorded until an admin sets one in Operations.";
    return "";
  }

  // The stage belongs to the athlete, not to this desk: whichever hand-over
  // they have not had yet is the one that happens now. Null means they hold
  // both and there is nothing left to give them.
  const stageType = result?.nextStage ?? null;
  const stageOne = stageType === "STAGE_1_WRISTBAND";
  const nothingLeft = Boolean(result) && stageType === null;
  // A closed window blocks both stages: the transponder desk is check-in too,
  // and letting Stage 2 through would put an athlete on the floor early by the
  // back door.
  const windowBlocked = result ? result.window.allowed === false : false;
  const canComplete = useMemo(() => {
    if (!result || !stageType || !assetCode.trim()) return false;
    if (result.window.allowed === false) return false;
    if (!stageOne) return true;
    return idVerified && declarationAccepted;
  }, [result, stageType, assetCode, stageOne, idVerified, declarationAccepted]);

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
    if (!value.trim()) return setMessage("Enter or scan a BIB first");
    try {
      const data = await jsonApi(`/api/hyfit-judge/checkin/participant?bib=${encodeURIComponent(value.trim())}`);
      setResult(data); setBib(value); setMessage(""); setReceipt(null);
    } catch (error) { setMessage((error as Error).message); }
  }
  async function findWristband(value = wristbandQuery) {
    if (!value.trim()) return setMessage("Enter or scan a wristband or transponder first");
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
          bib: result.participant.bib,
          // What this screen believed it was doing. The server works the stage
          // out for itself and refuses if the two disagree, so a tab left open
          // while another desk served the same athlete cannot write a
          // transponder into the wristband column.
          stageType, assetCode: assetCode.trim(),
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

  // Between athletes the header names the shift on duty; with one loaded it
  // names what that athlete is due, which is the counter's actual job and so
  // outranks it. "SHIFT", not a stage on its own, because this desk is not
  // limited to it — a Stage 1 volunteer still hands a transponder to an athlete
  // who is due one.
  const shiftLabel = context?.stage === "STAGE_1_WRISTBAND" ? "STAGE 1 SHIFT" : context?.stage === "STAGE_2_TRANSPONDER" ? "STAGE 2 SHIFT" : "";
  const stageLabel = !result ? (shiftLabel ? `CHECK-IN COUNTER · ${shiftLabel}` : "CHECK-IN COUNTER") : stageOne ? "STAGE 1 · WRISTBAND" : stageType ? "STAGE 2 · TRANSPONDER" : "NOTHING LEFT TO ISSUE";
  const shellStage = stageType === "STAGE_2_TRANSPONDER" ? "stage-two" : "stage-one";
  const participant = result?.participant;
  if (receipt) return <main className={`checkin-shell stage-shell ${receipt.stageType === "STAGE_2_TRANSPONDER" ? "stage-two" : "stage-one"}`}>
    <header><Image src="/branding/hyfit-games-2026-white.svg" width={55} height={55} unoptimized alt="HYFIT"/><div><small>{receipt.stageType === "STAGE_1_WRISTBAND" ? "STAGE 1 · WRISTBAND" : "STAGE 2 · TRANSPONDER"}</small><b>{context?.volunteer.name}</b></div><span className="ops-live">● RaceResult</span><ThemeToggle /><button className="checkin-signout" onClick={()=>void signOut()}>Sign out</button></header>
    <section className="stage-receipt"><div className="receipt-check">✓</div><small>{receipt.stageType === "STAGE_1_WRISTBAND" ? "WRISTBAND HANDED OVER" : "TRANSPONDER HANDED OVER"}</small><h1>BIB {receipt.bib}</h1><div className="receipt-asset"><span>{receipt.stageType === "STAGE_1_WRISTBAND" ? "WRISTBAND" : "TRANSPONDER1"}</span><b>{receipt.assetCode}</b></div>
      {/* Where this athlete goes next, so the volunteer can say it out loud. */}
      <p>{receipt.completedAt} · Saved to RaceResult{receipt.nextStage === "STAGE_2_TRANSPONDER" ? " · Send them on for a transponder" : receipt.nextStage === null ? " · Fully checked in" : ""}</p>
      <button className="stage-primary" onClick={reset}>Next athlete</button></section>
  </main>;

  return <main className={`checkin-shell stage-shell ${shellStage}`}>
    <header><Image src="/branding/hyfit-games-2026-white.svg" width={55} height={55} unoptimized alt="HYFIT"/><div><small>{stageLabel}</small><b>{context?.volunteer.name}</b></div><span className="ops-live">● RaceResult</span><ThemeToggle /><button className="checkin-signout" onClick={()=>void signOut()}>Sign out</button></header>
    {result && <div className="stage-rail"><b>{nothingLeft ? "✓" : stageOne ? "01" : "02"}</b><span>{nothingLeft ? "ALREADY HAS BOTH" : stageOne ? "VERIFY → DECLARE → WRISTBAND" : "WRISTBAND ON FILE → TRANSPONDER"}</span><small>{context?.volunteer.staffId} · {context?.volunteer.name}</small></div>}
    <section className="checkin-content stage-content">
      {message&&<div className="ops-message">{message}<button onClick={()=>setMessage("")}>×</button></div>}
      {!participant ? (
        // One entry point for both hand-overs. An athlete arriving for a
        // wristband has a race number; one arriving for a transponder has the
        // band they were given and nothing else. Either identifies them, and
        // what happens next is decided from what they already hold.
        <article className="scan-card stage-scan"><div className="scan-symbol">▦</div><small>CHECK-IN COUNTER</small><h1>Scan the athlete</h1><p>Their race QR, or any equipment already issued to them — wristband or transponder. The counter works out which hand-over they are due.</p>
          <button className="stage-primary" onClick={()=>setScanTarget("bib")}>Scan athlete QR</button>
          <div className="manual-line"><input inputMode="numeric" placeholder="Enter BIB manually" value={bib} onChange={(event)=>setBib(event.target.value)}/><button onClick={()=>void findBib()}>Find</button></div>
          <div className="manual-line"><input placeholder="Or enter wristband / transponder" value={wristbandQuery} onChange={(event)=>setWristbandQuery(event.target.value)}/><button onClick={()=>void findWristband()}>Find</button></div>
          <button className="checkin-reset" onClick={()=>setScanTarget("wristband_search")}>Scan equipment instead</button>
        </article>
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
          {isDoublesContestId(participant.contestId) && <article className="team-card"><small>DOUBLES TEAM · {participant.club || "Team data needs attention"}</small>{result!.teammates.map((mate)=><div key={mate.bib}><span><b>{mate.name}</b><small>BIB {mate.bib} · {mate.gender} · {displayDate(mate.dateOfBirth)}</small></span><em>{mate.transponderIssued ? "Stage 2 ✓" : mate.wristbandIssued ? "Stage 1 ✓" : "Waiting"}</em></div>)}{result!.teamWarning&&<p>⚠ {result!.teamWarning}</p>}</article>}
          {/* What they are already carrying, from the mapping table. Shown
              whenever there is anything, because it is the reason this counter
              is running the stage it is running. No timestamp: the mapping
              table records what was issued, not when. */}
          {result!.assignment.wristband && <article className="prior-stage-card"><small>ALREADY ISSUED</small><b>Wristband {result!.assignment.wristband}</b><span>Recorded in the mapping table</span></article>}
          {result!.assignment.transponder && <article className="prior-stage-card"><small>ALREADY ISSUED</small><b>Transponder {result!.assignment.transponder}</b><span>Recorded in the mapping table</span></article>}
        </section>
        <section className="action-column">
          {nothingLeft ? <article className="already-done"><b>✓ Fully checked in</b><p>Wristband {result!.assignment.wristband} · Transponder {result!.assignment.transponder}. Replacing either is a Help Desk job.</p><button className="stage-primary" onClick={reset}>Scan next athlete</button></article>
          : windowBlocked ? <article className="stage-blocked"><b>{result!.window.state === "early" ? "Outside this athlete's check-in window" : "This athlete's check-in window has closed"}</b><p>{result!.window.message}</p><button onClick={reset}>Scan another athlete</button></article>
          : stageOne ? <>
            <button className={`verify-button ${idVerified ? "confirmed" : ""}`} onClick={()=>setIdVerified(!idVerified)}><b>{idVerified ? "✓ ID verified" : "Government ID verified"}</b><span>Compare name, gender and date of birth</span></button>
            <article className="declaration-card"><small>PARTICIPANT DECLARATION</small><p>{context?.policy.declarationText}</p><label><input type="checkbox" checked={declarationAccepted} onChange={(event)=>setDeclarationAccepted(event.target.checked)}/><span>I confirm the athlete accepts this declaration</span></label></article>
            <button className="asset-scan-button" onClick={()=>setScanTarget("asset")}><small>WRISTBAND</small><b>{assetCode||"Scan wristband"}</b><span>{assetCode?"Tap to rescan":"Camera or manual entry"}</span></button>
          </>
          : <button className="asset-scan-button transponder" onClick={()=>setScanTarget("asset")}><small>TRANSPONDER1</small><b>{assetCode||"Scan transponder"}</b><span>{assetCode?"Tap to rescan":"Camera or manual entry"}</span></button>}
          {stageType && !windowBlocked && <><div className="manual-asset"><input placeholder={`Enter ${stageOne?"wristband":"transponder"} code`} value={assetCode} onChange={(event)=>setAssetCode(event.target.value)}/></div><MobileActionDock><button className="stage-primary complete-stage" disabled={!canComplete||busy} onClick={()=>void complete()}>{busy?"Saving to RaceResult…":`Hand over ${stageOne?"wristband":"transponder"}`}</button></MobileActionDock></>}
          <button className="checkin-reset" onClick={reset}>Cancel / change athlete</button>
        </section>
      </div>}
    </section>
    {scanTarget&&<QrScanner onClose={()=>setScanTarget(null)} onScan={scanned}/>}
  </main>;
}
