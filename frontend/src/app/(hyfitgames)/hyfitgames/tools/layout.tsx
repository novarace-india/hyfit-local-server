"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { appPath } from "../lib/api";
import HfgThemeToggle from "../lib/theme-toggle";

/* Venue tools: the two things someone running an event needs a screen for that
 * are not part of any of the four apps.
 *
 * Deliberately unauthenticated. The download page exists to be pointed at by a
 * phone that has no app and no account yet — a sign-in wall in front of it is a
 * wall in front of the installer — and the generator only encodes text that was
 * typed into it. Both are reachable only from the venue LAN, which is the same
 * boundary the rest of this server runs behind. */
const TOOLS = [
    { to: "/hyfitgames/tools/apps", label: "App downloads", icon: "⬇" },
    { to: "/hyfitgames/tools/qr", label: "QR generator", icon: "▦" },
];

export default function ToolsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    return (
        <div className="hfg-app min-h-dvh bg-ink">
            <header className="border-b border-smoke bg-coal">
                <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 lg:px-8">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src="/hyfitgames/hyfit-logo-red-SMZJ9JPG.png"
                        alt="HYFIT"
                        className="h-6 w-auto object-contain"
                    />
                    <span className="text-xs font-bold uppercase tracking-widest text-fog">Tools</span>
                    <HfgThemeToggle className="ml-auto !px-2 !py-1" />
                </div>
                <nav className="mx-auto flex max-w-5xl gap-1 px-4 pb-3 lg:px-8">
                    {TOOLS.map((t) => {
                        const active = pathname.startsWith(t.to) || pathname.startsWith(appPath(t.to));
                        return (
                            <Link
                                key={t.to}
                                href={appPath(t.to)}
                                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                                    active
                                        ? "bg-hyred/15 text-hyred-ink"
                                        : "text-fog hover:bg-smoke/40 hover:text-chalk"
                                }`}
                            >
                                <span aria-hidden>{t.icon}</span>
                                {t.label}
                            </Link>
                        );
                    })}
                </nav>
            </header>
            <main className="mx-auto max-w-5xl px-4 py-6 lg:px-8 lg:py-8">{children}</main>
        </div>
    );
}
