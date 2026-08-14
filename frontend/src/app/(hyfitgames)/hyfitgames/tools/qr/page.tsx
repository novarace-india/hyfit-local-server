"use client";

import { useMemo, useRef, useState } from "react";
import {
    EC_LABELS,
    QR_BYTE_CAPACITY,
    QrCode,
    byteLength,
    fitsInQr,
    type EcLevel,
} from "../qr-code";

/* Text/JSON → QR code.
 *
 * The payloads this gets pointed at are JSON blobs — endpoint configs, session
 * handoffs, whatever needs to cross from a screen to a phone that is not on the
 * network yet. So it does two things a generic generator does not: it tells you
 * whether what you pasted is valid JSON before you scan it into something, and
 * it re-serialises it compactly, because pretty-printed JSON spends a third of
 * a symbol's capacity on whitespace. */

const SAMPLE = `{
  "endpoint": "https://events.raceresult.com/12345",
  "eventId": "hyfit-2026-abu-dhabi",
  "apiKey": "REPLACE_ME"
}`;

type Parsed =
    | { kind: "empty" }
    | { kind: "json"; compact: string; error?: undefined }
    | { kind: "invalid-json"; error: string }
    | { kind: "text" };

// Whether the input is *meant* to be JSON decides how a parse failure reads: a
// shopping list is not "invalid JSON", it is just text, and flagging it red
// would be noise. Anything opening with a brace or bracket was meant to be.
function classify(raw: string): Parsed {
    const trimmed = raw.trim();
    if (!trimmed) return { kind: "empty" };
    const looksJson = /^[[{]/.test(trimmed);
    if (!looksJson) return { kind: "text" };
    try {
        return { kind: "json", compact: JSON.stringify(JSON.parse(trimmed)) };
    } catch (e) {
        return { kind: "invalid-json", error: e instanceof Error ? e.message : "Could not parse" };
    }
}

export default function QrGeneratorPage() {
    const [raw, setRaw] = useState("");
    const [level, setLevel] = useState<EcLevel>("M");
    const [minify, setMinify] = useState(true);
    const [copied, setCopied] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    const parsed = useMemo(() => classify(raw), [raw]);

    // What actually gets encoded. Minify only bites on valid JSON — there is no
    // safe whitespace to strip from free text, where every byte is meaningful.
    const payload = minify && parsed.kind === "json" ? parsed.compact : raw.trim();

    const bytes = byteLength(payload);
    const capacity = QR_BYTE_CAPACITY[level];
    const tooLong = !fitsInQr(payload, level);
    const canRender = payload.length > 0 && !tooLong;

    const saved =
        minify && parsed.kind === "json" ? byteLength(raw.trim()) - byteLength(parsed.compact) : 0;

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(payload);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard is origin- and gesture-gated and plain http counts as
            // insecure in some browsers, which is exactly what this server is.
            // The textarea is right there, so a failure needs no recovery path.
        }
    };

    const loadFile = async (file: File | undefined) => {
        if (!file) return;
        setRaw(await file.text());
        // Without this, picking the same file twice in a row fires no change
        // event and looks like the button stopped working.
        if (fileInput.current) fileInput.current.value = "";
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-xl font-bold text-chalk">QR generator</h1>
                <p className="mt-1 text-sm text-fog">
                    Paste text or JSON — the code updates as you type. Nothing leaves this
                    machine; the symbol is drawn in the browser.
                </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
                {/* Input */}
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor="qr-input" className="text-xs font-bold uppercase tracking-widest text-fog">
                            Content
                        </label>
                        <div className="ml-auto flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => fileInput.current?.click()}
                                className="rounded-lg border border-smoke px-2.5 py-1 text-xs font-semibold text-fog transition-colors hover:text-chalk"
                            >
                                Load file…
                            </button>
                            <input
                                ref={fileInput}
                                type="file"
                                accept=".json,.txt,.csv,text/plain,application/json"
                                className="hidden"
                                onChange={(e) => void loadFile(e.target.files?.[0])}
                            />
                            <button
                                type="button"
                                onClick={() => setRaw(SAMPLE)}
                                className="rounded-lg border border-smoke px-2.5 py-1 text-xs font-semibold text-fog transition-colors hover:text-chalk"
                            >
                                Sample
                            </button>
                            <button
                                type="button"
                                onClick={() => setRaw("")}
                                disabled={!raw}
                                className="rounded-lg border border-smoke px-2.5 py-1 text-xs font-semibold text-fog transition-colors hover:text-chalk disabled:opacity-40"
                            >
                                Clear
                            </button>
                        </div>
                    </div>

                    <textarea
                        id="qr-input"
                        value={raw}
                        onChange={(e) => setRaw(e.target.value)}
                        spellCheck={false}
                        placeholder={'{ "eventId": "hyfit-2026", "endpoint": "https://…" }'}
                        className="h-72 w-full resize-y rounded-xl border border-smoke bg-coal px-3 py-2.5 font-mono text-sm text-chalk placeholder:text-fog/60 focus:border-hyred focus:outline-none"
                    />

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                        {parsed.kind === "json" && (
                            <span className="rounded-full bg-good-soft px-2.5 py-0.5 font-semibold text-good">
                                Valid JSON
                            </span>
                        )}
                        {parsed.kind === "invalid-json" && (
                            <span className="rounded-full bg-bad-soft px-2.5 py-0.5 font-semibold text-bad">
                                Invalid JSON — {parsed.error}
                            </span>
                        )}
                        {parsed.kind === "text" && (
                            <span className="rounded-full bg-smoke px-2.5 py-0.5 font-semibold text-fog">
                                Plain text
                            </span>
                        )}
                        <span className={tooLong ? "font-semibold text-bad" : "text-fog"}>
                            {bytes.toLocaleString()} / {capacity.toLocaleString()} bytes
                        </span>
                        {saved > 0 && <span className="text-fog">minified −{saved.toLocaleString()} bytes</span>}
                    </div>

                    <div className="flex flex-wrap items-end gap-4 border-t border-smoke pt-4">
                        <div>
                            <label
                                htmlFor="qr-level"
                                className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-fog"
                            >
                                Error correction
                            </label>
                            <select
                                id="qr-level"
                                value={level}
                                onChange={(e) => setLevel(e.target.value as EcLevel)}
                                className="rounded-lg border border-smoke bg-coal px-2.5 py-1.5 text-sm text-chalk"
                            >
                                {(Object.keys(EC_LABELS) as EcLevel[]).map((l) => (
                                    <option key={l} value={l}>
                                        {EC_LABELS[l]}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <label className="flex items-center gap-2 pb-1.5 text-sm text-fog">
                            <input
                                type="checkbox"
                                checked={minify}
                                onChange={(e) => setMinify(e.target.checked)}
                                className="h-4 w-4 accent-hyred"
                            />
                            Minify JSON before encoding
                        </label>
                        <button
                            type="button"
                            onClick={() => void copy()}
                            disabled={!payload}
                            className="ml-auto rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-fog transition-colors hover:text-chalk disabled:opacity-40"
                        >
                            {copied ? "Copied" : "Copy payload"}
                        </button>
                    </div>
                </div>

                {/* Output */}
                <div className="lg:w-[22rem]">
                    <div className="rounded-2xl border border-smoke bg-coal p-5">
                        {canRender ? (
                            <QrCode
                                value={payload}
                                level={level}
                                size={288}
                                downloadName="hyfit-qr"
                                caption={
                                    parsed.kind === "json"
                                        ? `Encoding ${minify ? "minified" : "verbatim"} JSON`
                                        : undefined
                                }
                            />
                        ) : (
                            <div className="flex h-[22rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-smoke px-6 text-center">
                                <p className="font-semibold text-chalk">
                                    {tooLong ? "Too much to encode" : "Nothing to encode yet"}
                                </p>
                                <p className="text-sm text-fog">
                                    {tooLong ? (
                                        <>
                                            A QR symbol holds {capacity.toLocaleString()} bytes at level{" "}
                                            {level}. Drop to level L for {QR_BYTE_CAPACITY.L.toLocaleString()},
                                            or send a short URL pointing at the data instead.
                                        </>
                                    ) : (
                                        "Paste something on the left."
                                    )}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
