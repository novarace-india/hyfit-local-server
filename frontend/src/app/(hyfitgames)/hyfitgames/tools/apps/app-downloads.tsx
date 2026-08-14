"use client";

import { useEffect, useMemo, useState } from "react";
import { QrCode } from "../qr-code";
import type { AppBuild } from "./builds";

/* The install page: one QR per app, each encoding an absolute URL to that
 * app's .apk.
 *
 * The host in that URL is the whole problem this component solves. The page is
 * usually open on a laptop at `localhost:3000`, and a QR built from that scans
 * perfectly and then fails on the phone, because the phone's localhost is the
 * phone. So the host is picked here, in the browser, from the address bar when
 * that is already a real address and from the server's own LAN interfaces when
 * it is not — and it stays switchable, because a machine on both Wi-Fi and
 * Ethernet has two addresses and only one of them is the one the phones are on. */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);

const formatSize = (bytes: number) =>
    bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function AppDownloads({
    builds,
    lanHosts,
}: {
    builds: AppBuild[];
    lanHosts: string[];
}) {
    // Null until mounted: everything below depends on the address bar, and the
    // server has no address bar to read. Also keeps the timestamps out of the
    // server render, where they would format in the server's timezone and then
    // disagree with the client's on hydration.
    const [host, setHost] = useState<string | null>(null);
    const [protocol, setProtocol] = useState("http:");
    const [hostOptions, setHostOptions] = useState<string[]>([]);

    useEffect(() => {
        const { hostname, port, host: currentHost, protocol: currentProtocol } = window.location;
        const suffix = port ? `:${port}` : "";
        // The LAN addresses come from the server's interfaces, so they carry no
        // port; they are only reachable on the one this page was served on.
        const lan = lanHosts.map((ip) => `${ip}${suffix}`);
        const onLoopback = LOOPBACK.has(hostname);

        setProtocol(currentProtocol);
        setHostOptions([...new Set([currentHost, ...lan])]);
        setHost(onLoopback && lan.length ? lan[0] : currentHost);
    }, [lanHosts]);

    const origin = host ? `${protocol}//${host}` : null;
    const reachable = host ? !LOOPBACK.has(host.replace(/:\d+$/, "")) : true;
    const anyBuilds = useMemo(() => builds.some((b) => b.href), [builds]);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-xl font-bold text-chalk">Install the field apps</h1>
                <p className="mt-1 text-sm text-fog">
                    Scan a code with the phone that needs the app. Both installers are served
                    from this machine — no store, no internet.
                </p>
            </div>

            {/* Host picker */}
            <div className="rounded-2xl border border-smoke bg-coal p-4">
                <div className="flex flex-wrap items-center gap-3">
                    <label
                        htmlFor="download-host"
                        className="text-[10px] font-bold uppercase tracking-widest text-fog"
                    >
                        Phones download from
                    </label>
                    <select
                        id="download-host"
                        value={host ?? ""}
                        onChange={(e) => setHost(e.target.value)}
                        disabled={!host}
                        className="rounded-lg border border-smoke bg-coal px-2.5 py-1.5 font-mono text-sm text-chalk"
                    >
                        {host === null && <option value="">Reading address…</option>}
                        {hostOptions.map((h) => (
                            <option key={h} value={h}>
                                {h}
                            </option>
                        ))}
                    </select>
                </div>
                {!reachable && (
                    <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
                        {lanHosts.length
                            ? "That is this machine's own loopback address — a phone scanning it will not reach anything. Pick one of the LAN addresses above."
                            : "This page is on localhost and the server reports no LAN address, so there is nothing a phone can reach. Connect this machine to the venue network and reload."}
                    </p>
                )}
                {reachable && host && (
                    <p className="mt-3 text-xs text-fog">
                        The phone must be on the same network as this machine. Serve with{" "}
                        <code className="rounded bg-smoke px-1 py-0.5 text-chalk">npm run dev:lan</code>{" "}
                        so the LAN can reach it.
                    </p>
                )}
            </div>

            <div className="grid gap-5 md:grid-cols-2">
                {builds.map((build) => (
                    <BuildCard key={build.slug} build={build} origin={origin} />
                ))}
            </div>

            {anyBuilds && (
                <p className="rounded-2xl border border-dashed border-smoke px-4 py-3 text-xs text-fog">
                    Android treats these as unknown-source installs: the browser will warn about
                    the download, and the phone will ask for permission to install from it. Both
                    prompts are expected — accept them, then open the downloaded file.
                </p>
            )}
        </div>
    );
}

function BuildCard({ build, origin }: { build: AppBuild; origin: string | null }) {
    const url = origin && build.href ? `${origin}${build.href}` : null;

    return (
        <div className="flex flex-col rounded-2xl border border-smoke bg-coal p-5">
            <div className="mb-4">
                <h2 className="font-bold text-chalk">{build.label}</h2>
                <p className="mt-0.5 text-sm text-fog">{build.blurb}</p>
            </div>

            {!build.href ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-smoke px-4 py-10 text-center">
                    <p className="font-semibold text-chalk">No build uploaded</p>
                    <p className="text-sm text-fog">
                        Copy the <code className="rounded bg-smoke px-1 py-0.5 text-chalk">.apk</code>{" "}
                        into
                    </p>
                    <code className="rounded bg-smoke px-2 py-1 text-xs text-chalk">{build.folder}</code>
                    <p className="text-xs text-fog">then reload this page.</p>
                </div>
            ) : (
                <>
                    <div className="flex-1">
                        {url ? (
                            <QrCode
                                value={url}
                                size={220}
                                downloadName={`hyfit-${build.slug}-install`}
                                caption={url}
                            />
                        ) : (
                            <div className="flex h-[17rem] items-center justify-center text-sm text-fog">
                                Preparing code…
                            </div>
                        )}
                    </div>

                    <dl className="mt-5 space-y-1 border-t border-smoke pt-4 text-xs">
                        <Row label="File" value={build.fileName!} mono />
                        <Row label="Size" value={formatSize(build.sizeBytes!)} />
                        <Row label="Added" value={<LocalTime iso={build.modifiedAt!} />} />
                    </dl>

                    <a
                        href={build.href}
                        download
                        className="mt-4 rounded-lg bg-hyred px-3 py-2 text-center text-xs font-bold uppercase tracking-wider text-onfill transition-opacity hover:opacity-90"
                    >
                        Download on this device
                    </a>

                    {build.olderBuilds.length > 0 && (
                        <details className="mt-3">
                            <summary className="cursor-pointer text-xs text-fog hover:text-chalk">
                                {build.olderBuilds.length} older build
                                {build.olderBuilds.length > 1 ? "s" : ""} in the folder
                            </summary>
                            <ul className="mt-2 space-y-1">
                                {build.olderBuilds.map((o) => (
                                    <li key={o.fileName}>
                                        <a
                                            href={o.href}
                                            download
                                            className="font-mono text-xs text-fog underline decoration-smoke hover:text-chalk"
                                        >
                                            {o.fileName}
                                        </a>{" "}
                                        <span className="text-xs text-fog">({formatSize(o.sizeBytes)})</span>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </>
            )}
        </div>
    );
}

function Row({
    label,
    value,
    mono,
}: {
    label: string;
    value: React.ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="flex gap-3">
            <dt className="w-14 flex-shrink-0 text-fog">{label}</dt>
            <dd className={`min-w-0 break-all text-chalk ${mono ? "font-mono" : ""}`}>{value}</dd>
        </div>
    );
}

// The server renders in the server's timezone and the browser in the browser's,
// which is a hydration mismatch on a machine set to anything but UTC. So the
// date alone is rendered on both sides, and the local time is filled in once
// there is a browser to ask.
function LocalTime({ iso }: { iso: string }) {
    const [local, setLocal] = useState<string | null>(null);
    useEffect(() => setLocal(new Date(iso).toLocaleString()), [iso]);
    return <>{local ?? iso.slice(0, 10)}</>;
}
