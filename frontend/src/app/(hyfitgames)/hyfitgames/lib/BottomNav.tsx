import Link from "next/link";
import { usePathname } from "next/navigation";
import { appPath } from "./api";

/* Bottom navigation for athlete pages. Ported from components/BottomNav.jsx;
   NavLink → next/link + usePathname for the active state. */
function Item({ to, label, icon }: { to: string; label: string; icon: string }) {
    const pathname = usePathname();
    const resolvedPath = appPath(to);
    const isActive = pathname === resolvedPath || pathname === to;
    return (
        <Link
            href={resolvedPath}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
                isActive ? "text-hyred-ink" : "text-fog"
            }`}
        >
            <span aria-hidden className="text-lg leading-none">
                {icon}
            </span>
            {label}
        </Link>
    );
}

export default function BottomNav() {
    return (
        <nav
            className="fixed bottom-0 left-1/2 z-20 w-full max-w-md -translate-x-1/2
                       border-t border-smoke bg-coal/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
        >
            <div className="flex items-center">
                <Item to="/hyfitgames" label="Home" icon="⌂" />
                <Item to="/hyfitgames/history" label="My Journey" icon="↗" />
                <div className="flex flex-col items-center gap-0.5 px-3 py-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src="/hyfitgames/hyfit-logo-red.png"
                        alt="HYFIT"
                        className="max-h-5 w-auto object-contain"
                    />
                </div>
                <Item to="/hyfitgames/profile" label="Profile" icon="●" />
            </div>
        </nav>
    );
}
