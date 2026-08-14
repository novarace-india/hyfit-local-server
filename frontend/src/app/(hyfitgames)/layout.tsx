import "./hfg.css";
import type { Metadata, Viewport } from "next";

// Root layout for the HYFIT Games athlete platform (mounted at /hyfitgames).
// This is a separate root layout from the main Novarace (user) app — it owns
// its own <html>/<body> and dark theme so the module stays visually and
// behaviourally isolated from the rest of the site.
export const metadata: Metadata = {
    title: "HYFIT Games — Athlete Hub",
    description:
        "HYFIT Games athlete area: profiles, live scoring, results, leaderboards and finisher certificates.",
    robots: { index: false, follow: false },
    icons: {
        icon: [
            { url: "/hyfitgames/hyfit-logo-red-SMZJ9JPG.png", type: "image/png" },
        ],
        shortcut: "/hyfitgames/hyfit-logo-red-SMZJ9JPG.png",
        apple: "/hyfitgames/hyfit-logo-red-SMZJ9JPG.png",
    },
};

export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    themeColor: "#121212",
};

// Applies the stored theme before the first paint, so someone who chose light
// does not get a dark flash on every navigation. Runs synchronously in <body>
// ahead of the tree for that reason — a useEffect would paint dark first.
//
// Dark is the default, so the attribute is only ever set for an explicit light
// choice. The legacy key is read as a fallback: the toggle used to be
// admin-only and stored `hyfit-admin-theme`, and that preference should carry
// over rather than silently reset now that it covers the whole app.
const HFG_THEME_BOOTSTRAP = `try{var t=localStorage.getItem("hyfit-theme")||localStorage.getItem("hyfit-admin-theme");if(t==="light"){document.documentElement.dataset.hfgTheme="light";var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content","#f3f3f1")}}catch(e){}`;

export default function HyfitgamesRootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className="hfg-root" suppressHydrationWarning>
                <script dangerouslySetInnerHTML={{ __html: HFG_THEME_BOOTSTRAP }} />
                {children}
            </body>
        </html>
    );
}
