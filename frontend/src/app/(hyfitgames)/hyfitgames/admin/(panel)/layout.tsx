"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { adminSession, appPath } from "../../lib/api";
import { Spinner } from "../../lib/ui";
import { useRequireAdmin } from "../../lib/guards";
import HfgThemeToggle from "../../lib/theme-toggle";
import { FieldSessionProvider, useFieldSession } from "../../lib/field-session";

// The HYFIT field-operations console: run an event, staff it, point it at
// RaceResult, and publish what came back. Everything here reads and writes
// `hyfit_v2` and nothing else.
//
// The old athlete-platform screens — Timing, Protests, Announcements, and the
// event detail page with its categories and entries — are gone. They were views
// over the `hyfit` schema, which this deployment does not have, so every one of
// them answered 500.
//
// Athletes and Results came back as `hyfit_v2` screens (migration 083), and the
// distinction matters: both are a READ of what was imported from this event's
// RaceResult endpoints, never a second roster. The counters and tablets resolve
// a bib against RaceResult live, and an admin screen quietly showing a
// different set of athletes than they are working against is worse than no
// screen at all.
const NAV = [
    { to: "/hyfitgames/admin", label: "Dashboard", icon: "◫", end: true },
    { to: "/hyfitgames/admin/events", label: "Events", icon: "▤" },
];

// These are screens of ONE event, so they are not fixed destinations the way
// the entries above are — each needs an event id in its path. The id comes from
// the event you are already looking at, and otherwise from the field session's
// event, which is the one these screens used to assume silently. With neither,
// they point at the Events list: "choose which event" is the honest answer, and
// it is what the old implicit behaviour got wrong whenever no event was active.
//
// Ordered the way an event is actually run: staff it, wire it to RaceResult,
// pull the start list, publish what they did — and, for an event run at a venue
// on a local server, send that up to the deployment the public reads.
const FIELD_NAV = [
    { segment: "team", label: "Team", icon: "♟" },
    { segment: "operations", label: "Operations", icon: "⚙" },
    { segment: "athletes", label: "Athletes", icon: "♞" },
    { segment: "results", label: "Results", icon: "▣" },
    // Last because it is last chronologically, and present on every event
    // rather than only offline ones: this screen is also where an event is MADE
    // offline, so hiding it until it had been used would hide the switch.
    { segment: "sync", label: "Sync", icon: "⇅" },
];

function eventIdFromPath(pathname: string): string | null {
    return /\/admin\/events\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
    return (
        <FieldSessionProvider>
            <AdminShell>{children}</AdminShell>
        </FieldSessionProvider>
    );
}

function AdminShell({ children }: { children: React.ReactNode }) {
    const ready = useRequireAdmin();
    const field = useFieldSession();
    const router = useRouter();
    const pathname = usePathname();
    // One sign-out ends both sessions. Leaving the field cookie behind would
    // hand the next person at the same browser a live operations session.
    const logout = () => {
        void field.signOut();
        adminSession.logout();
        router.replace(appPath("/hyfitgames/admin/login"));
    };

    const eventId = eventIdFromPath(pathname) ?? field.user?.eventId ?? null;
    const fieldNav = FIELD_NAV.map((n) => ({
        ...n,
        to: eventId
            ? `/hyfitgames/admin/events/${eventId}/${n.segment}`
            : "/hyfitgames/admin/events",
    }));

    const isActive = (to: string, end?: boolean) => {
        const resolvedTo = appPath(to);
        return end ? (pathname === to || pathname === resolvedTo) : (pathname.startsWith(to) || pathname.startsWith(resolvedTo));
    };

    if (!ready)
        return (
            <div className="hfg-admin min-h-dvh bg-ink">
                <Spinner />
            </div>
        );

    return (
        <div className="hfg-admin flex min-h-dvh bg-ink">
            {/* Sidebar */}
            <aside className="hidden w-56 flex-shrink-0 border-r border-smoke bg-coal lg:flex lg:flex-col">
                <div className="flex items-center gap-3 border-b border-smoke px-5 py-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src="/hyfitgames/hyfit-logo-red-SMZJ9JPG.png"
                        alt="HYFIT"
                        className="h-6 w-auto object-contain"
                    />
                    <span className="text-xs font-bold uppercase tracking-widest text-fog">Admin</span>
                    <HfgThemeToggle className="ml-auto !px-2 !py-1" />
                </div>
                <nav className="flex-1 space-y-0.5 px-3 py-4">
                    {NAV.map((n) => (
                        <Link
                            key={n.to}
                            href={appPath(n.to)}
                            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                                isActive(n.to, n.end)
                                    ? "bg-hyred/15 text-hyred-ink"
                                    : "text-fog hover:text-chalk hover:bg-smoke/40"
                            }`}
                        >
                            <span className="w-5 text-center text-base">{n.icon}</span>
                            {n.label}
                        </Link>
                    ))}
                    <div className="mt-4 mb-1 border-t border-smoke pt-3">
                        <span className="px-3 text-[10px] font-bold uppercase tracking-widest text-fog">
                            {eventId ? "This event" : "Field operations"}
                        </span>
                    </div>
                    {fieldNav.map((n) => (
                        <Link
                            key={n.segment}
                            href={appPath(n.to)}
                            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                                isActive(n.to)
                                    ? "bg-hyred/15 text-hyred-ink"
                                    : "text-fog hover:text-chalk hover:bg-smoke/40"
                            }`}
                        >
                            <span className="w-5 text-center text-base">{n.icon}</span>
                            {n.label}
                        </Link>
                    ))}
                </nav>
                <div className="border-t border-smoke px-3 py-3">
                    <button
                        onClick={logout}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm text-fog hover:bg-smoke/40 hover:text-chalk"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            {/* Mobile top bar */}
            <div className="fixed inset-x-0 top-0 z-30 flex items-center border-b border-smoke bg-coal/95 px-4 py-3 backdrop-blur lg:hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src="/hyfitgames/hyfit-logo-red-SMZJ9JPG.png"
                    alt="HYFIT"
                    className="h-5 w-auto object-contain"
                />
                <span className="ml-2 text-xs font-bold uppercase tracking-widest text-fog">Admin</span>
                <div className="ml-auto flex items-center gap-2">
                    <select
                        onChange={(e) => {
                            if (e.target.value) router.push(appPath(e.target.value));
                        }}
                        className="rounded-lg border border-smoke bg-coal px-2 py-1 text-xs text-fog"
                        defaultValue=""
                    >
                        <option value="" disabled>
                            Navigate…
                        </option>
                        {/* Keyed by label, not `to`: without an event the field
                            entries both fall back to the Events list, so their
                            hrefs collide with each other and with Events. */}
                        {[...NAV, ...fieldNav].map((n) => (
                            <option key={n.label} value={appPath(n.to)}>
                                {n.label}
                            </option>
                        ))}
                    </select>
                    <HfgThemeToggle className="px-2 py-1" />
                    <button onClick={logout} className="text-xs text-fog hover:text-chalk">
                        Sign out
                    </button>
                </div>
            </div>

            {/* Main content */}
            <main className="flex-1 overflow-y-auto pb-8 pt-14 lg:pt-0">
                <div className="mx-auto max-w-6xl px-4 py-6 lg:px-8 lg:py-8">{children}</div>
            </main>
        </div>
    );
}
