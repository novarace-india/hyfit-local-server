import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/* Reads the installers dropped into `public/apps/<slug>/`.
 *
 * Server-only — imported by the page, never by a client component.
 *
 * The folder is the source of truth rather than a config file or a database
 * row: the whole release process at a venue is "copy the new build in", often
 * from a laptop by someone who is not going to edit a TypeScript file to do it.
 * Newest mtime wins, so a rollback is copying the old file back. */

export type AppSlug = "judge" | "checkin";

export type AppBuild = {
    slug: AppSlug;
    label: string;
    blurb: string;
    /** Where the page tells you to put the file when there is nothing there. */
    folder: string;
    /** Root-relative URL of the current build, or null when the folder is empty. */
    href: string | null;
    fileName: string | null;
    sizeBytes: number | null;
    modifiedAt: string | null;
    /** Every other .apk in the folder, newest first. */
    olderBuilds: { fileName: string; href: string; sizeBytes: number; modifiedAt: string }[];
};

const APPS: { slug: AppSlug; label: string; blurb: string }[] = [
    {
        slug: "judge",
        label: "Judge app",
        blurb: "Scoring, timing and penalties at the station.",
    },
    {
        slug: "checkin",
        label: "Check-in app",
        blurb: "BIB and asset scanning at athlete check-in.",
    },
];

function publicDir(slug: AppSlug) {
    return path.join(process.cwd(), "public", "apps", slug);
}

export async function readBuilds(): Promise<AppBuild[]> {
    return Promise.all(APPS.map(readOne));
}

async function readOne(app: (typeof APPS)[number]): Promise<AppBuild> {
    const dir = publicDir(app.slug);
    const folder = `public/apps/${app.slug}/`;
    const base: AppBuild = {
        ...app,
        folder,
        href: null,
        fileName: null,
        sizeBytes: null,
        modifiedAt: null,
        olderBuilds: [],
    };

    let names: string[];
    try {
        names = await fs.readdir(dir);
    } catch {
        // Folder deleted or never created. Same story as an empty one from the
        // page's point of view: there is no build to hand out.
        return base;
    }

    const stats = await Promise.all(
        names
            .filter((n) => n.toLowerCase().endsWith(".apk"))
            .map(async (fileName) => {
                const s = await fs.stat(path.join(dir, fileName));
                return {
                    fileName,
                    href: `/apps/${app.slug}/${encodeURIComponent(fileName)}`,
                    sizeBytes: s.size,
                    modifiedAt: s.mtime.toISOString(),
                    mtimeMs: s.mtimeMs,
                };
            }),
    );

    if (!stats.length) return base;

    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const [current, ...older] = stats;

    return {
        ...base,
        href: current.href,
        fileName: current.fileName,
        sizeBytes: current.sizeBytes,
        modifiedAt: current.modifiedAt,
        olderBuilds: older.map(({ mtimeMs: _mtimeMs, ...rest }) => rest),
    };
}

/* The machine's LAN addresses, for when the page is being viewed on loopback.
 *
 * A QR built from `localhost:3000` scans fine and then fails on the phone,
 * which is a confusing five minutes to spend at a venue. Offering the real
 * addresses turns that into a dropdown. */
export function lanAddresses(): string[] {
    const found = new Set<string>();
    for (const nics of Object.values(os.networkInterfaces())) {
        for (const nic of nics ?? []) {
            // Node <18.4 reported `family` as the number 4; both spellings are
            // still in the wild depending on how the runtime was built.
            const v4 = nic.family === "IPv4" || (nic.family as unknown as number) === 4;
            if (v4 && !nic.internal) found.add(nic.address);
        }
    }
    return [...found].sort();
}
