/* Shared UI atoms, ported from the module's components/ui.jsx. */
import type { ReactNode } from "react";

export const Spinner = () => (
    <div className="flex justify-center py-10">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-smoke border-t-hyred" />
    </div>
);

export const ErrorNote = ({ msg }: { msg?: string }) =>
    msg ? <p className="rounded-lg bg-hyred/15 px-3 py-2 text-sm text-bad">{msg}</p> : null;

type Tone = "default" | "live" | "ok" | "warn";

export const Chip = ({ children, tone = "default" }: { children: ReactNode; tone?: Tone }) => {
    const tones: Record<Tone, string> = {
        default: "bg-smoke text-fog",
        live: "bg-hyred text-onfill animate-pulse",
        ok: "bg-good-soft text-good",
        warn: "bg-warn-soft text-warn",
    };
    return (
        <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${tones[tone]}`}
        >
            {children}
        </span>
    );
};

export const statusChip = (s: string) =>
    s === "FIN" ? (
        <Chip tone="ok">Finisher</Chip>
    ) : s === "DNF" ? (
        <Chip tone="warn">DNF</Chip>
    ) : s === "DNS" ? (
        <Chip>DNS</Chip>
    ) : s === "DQ" ? (
        <Chip tone="warn">DQ</Chip>
    ) : (
        <Chip>Registered</Chip>
    );

export const Empty = ({ title, hint }: { title: string; hint?: string }) => (
    <div className="rounded-2xl border border-dashed border-smoke p-8 text-center">
        <p className="font-semibold text-chalk">{title}</p>
        {hint && <p className="mt-1 text-sm text-fog">{hint}</p>}
    </div>
);

export const SectionTitle = ({ children }: { children: ReactNode }) => (
    <h2 className="mb-3 mt-7 text-xs font-bold uppercase tracking-[0.18em] text-fog">{children}</h2>
);
