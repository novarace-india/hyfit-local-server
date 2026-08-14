"use client";

/* Legacy URL — see the note in ../team/page.tsx. Operations now lives at
 * /admin/events/:id/operations. */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { appPath } from "../../../lib/api";
import { Spinner } from "../../../lib/ui";
import { useFieldSession } from "../../../lib/field-session";

export default function LegacyOperationsRedirect() {
    const router = useRouter();
    const { user, ready } = useFieldSession();

    useEffect(() => {
        if (!ready) return;
        router.replace(
            appPath(
                user?.eventId
                    ? `/hyfitgames/admin/events/${user.eventId}/operations`
                    : "/hyfitgames/admin/events",
            ),
        );
    }, [ready, user?.eventId, router]);

    return <Spinner />;
}
