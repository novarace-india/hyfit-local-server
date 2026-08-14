"use client";
import { useEffect, useState } from "react";

export const HFG_THEME_KEY = "hyfit-theme";
// Read once so an admin who already chose light before the athlete pages were
// themed keeps their choice instead of being silently reset to dark.
export const HFG_LEGACY_THEME_KEY = "hyfit-admin-theme";

// Light/dark switch for the whole HYFIT Games solution — athlete app, login
// and admin console. One choice covers all of them: they are one product on
// one origin, and a person who dims the console and then opens their profile
// should not be flashbanged.
//
// Deliberately still separate from the judge app's toggle (`hyfit-judge-theme`,
// `data-theme`): that is a field tablet with its own design system and the
// opposite default (light, for daylight), and a volunteer who dims a tablet in
// a loading bay has no reason to have dimmed anyone's desk browser.
//
// This side is dark by default, so the attribute is only ever set for an
// explicit light choice. `data-hfg-theme` lives on <html>; hfg.css scopes the
// light palette to `.hfg-root`, which wraps every /hyfitgames route.
export default function HfgThemeToggle({ className = "" }: { className?: string }) {
    const [theme, setTheme] = useState<"light" | "dark">("dark");

    useEffect(() => {
        setTheme(document.documentElement.dataset.hfgTheme === "light" ? "light" : "dark");
    }, []);

    const toggle = () => {
        const next = theme === "light" ? "dark" : "light";
        setTheme(next);
        if (next === "light") document.documentElement.dataset.hfgTheme = "light";
        else delete document.documentElement.dataset.hfgTheme;
        // The mobile browser chrome is painted from this meta, not from CSS, so
        // it stays dark behind a light page unless it is updated by hand. Very
        // visible on the athlete app, which is phone-first.
        document
            .querySelector('meta[name="theme-color"]')
            ?.setAttribute("content", next === "light" ? "#f3f3f1" : "#121212");
        try {
            localStorage.setItem(HFG_THEME_KEY, next);
        } catch {
            // Private window or blocked storage: the theme still applies for
            // this session, it just is not remembered.
        }
    };

    const light = theme === "light";

    return (
        <button
            type="button"
            onClick={toggle}
            aria-pressed={light}
            title={light ? "Switch to dark mode" : "Switch to light mode"}
            className={`inline-flex items-center gap-2 rounded-lg border border-smoke px-3 py-2 text-xs font-bold uppercase tracking-wider text-fog transition-colors hover:text-chalk ${className}`}
        >
            {light ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                    <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z" />
                </svg>
            ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                    <circle cx="12" cy="12" r="4.2" />
                    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
                </svg>
            )}
            <span className="hidden sm:inline">{light ? "Dark" : "Light"}</span>
        </button>
    );
}
