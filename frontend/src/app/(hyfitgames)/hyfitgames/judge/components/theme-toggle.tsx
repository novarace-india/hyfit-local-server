"use client";
import { useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "hyfit-judge-theme";

// Light/dark switch for the judge app. The theme lives as `data-theme` on
// <html>; the inline script in layout.tsx applies the stored choice before
// first paint, so this component only has to keep the attribute and
// localStorage in step with the button.
//
// It renders the light-mode icon on the server and on the first client render
// so hydration matches, then corrects itself in the effect below for a judge
// who has chosen dark.
export default function ThemeToggle() {
    const [theme, setTheme] = useState<"light" | "dark">("light");

    useEffect(() => {
        setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    }, []);

    const toggle = () => {
        const next = theme === "dark" ? "light" : "dark";
        setTheme(next);
        document.documentElement.dataset.theme = next;
        try {
            localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
            // Private browsing or a locked-down tablet profile: the theme still
            // applies for this session, it just won't be remembered.
        }
    };

    const dark = theme === "dark";

    return (
        <button
            type="button"
            className="theme-toggle"
            onClick={toggle}
            aria-pressed={dark}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
            {dark ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="4.2" />
                    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
                </svg>
            ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z" />
                </svg>
            )}
            <span>{dark ? "Light" : "Dark"}</span>
        </button>
    );
}
