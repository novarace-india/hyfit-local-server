"use client";
import BottomNav from "../lib/BottomNav";
import { Spinner } from "../lib/ui";
import { useRequireAthlete } from "../lib/guards";
import HfgThemeToggle from "../lib/theme-toggle";

// Athlete chrome: the mobile-first max-w-md column + bottom nav that App.jsx
// wrapped every logged-in athlete route in. Gated behind the athlete session.
export default function AthleteLayout({ children }: { children: React.ReactNode }) {
    const ready = useRequireAthlete();
    return (
        <div className="hfg-app mx-auto max-w-md min-h-dvh pb-20">
            {/* The theme switch lives in the layout so it is on every athlete
                screen, not just Profile. These pages have no shared header to
                hang it off — each writes its own <main> and title — so it
                floats, pinned to the top-right of the column rather than the
                viewport so it tracks the content on a wide screen.
                The wrapper is click-through; only the button itself takes
                pointer events, so it never steals a tap from the page under it. */}
            {ready && (
                <div className="pointer-events-none fixed inset-x-0 top-0 z-30 mx-auto flex max-w-md justify-end px-3 pt-3">
                    <HfgThemeToggle className="pointer-events-auto !px-2 !py-1.5 bg-coal/85 backdrop-blur" />
                </div>
            )}
            {ready ? children : <Spinner />}
            {ready && <BottomNav />}
        </div>
    );
}
