"use client";

/* Legacy URL. Team is now a screen of one event — /admin/events/:id/team — so
 * this only resolves "which event?" and forwards.
 *
 * It stays because /hyfitgames/admin/team is on staff bookmarks and printed run
 * sheets, and an event morning is the wrong time to hand a volunteer a 404. The
 * field session's event is the same one this page used to show implicitly, so a
 * bookmark lands exactly where it always did — just with the event now named in
 * the URL. */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { appPath } from "../../../lib/api";
import { Spinner } from "../../../lib/ui";
import { useFieldSession } from "../../../lib/field-session";

export default function LegacyTeamRedirect() {
    const router = useRouter();
    const { user, ready } = useFieldSession();

    useEffect(() => {
        if (!ready) return;
        router.replace(
            appPath(
                user?.eventId
                    ? `/hyfitgames/admin/events/${user.eventId}/team`
                    : "/hyfitgames/admin/events",
            ),
        );
    }, [ready, user?.eventId, router]);

    return <Spinner />;
}
