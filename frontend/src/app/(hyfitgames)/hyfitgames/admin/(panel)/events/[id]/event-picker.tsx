"use client";

/* The event selector for the two field-operations screens.
 *
 * Team and Operations are screens OF an event, so the event is in the path
 * rather than in a global "current event" somewhere off-screen. That makes the
 * URL honest and shareable, but it also means there has to be a way to change
 * it without going back out to the Events list — which is what this is.
 *
 * Switching replaces rather than pushes: /events/A/team -> /events/B/team is
 * the same screen looking somewhere else, not a step Back should walk through
 * one event at a time.
 *
 * Field staff (a non-null boundEventId) get their event as a label instead of a
 * dropdown. They are hired for one event and the backend answers 403 for any
 * other, so offering the choice would only produce an error on use.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appPath, judgeApi } from "../../../../lib/api";
import { useFieldSession } from "../../../../lib/field-session";

type FieldEvent = {
    id: string;
    name: string;
    status: string | null;
    is_active: boolean;
    // No city or date: those are the public listing's, and this list is the
    // operational events only. The venue is what an operator recognises a
    // field event by anyway.
    venue: string;
    starts_at: string | null;
    // The athlete-platform listing this event is run as, when it has one. The
    // id in the URL may be either (see resolveEventId on the backend), so the
    // picker has to recognise both or it shows no selection at all for an event
    // reached from the athlete console.
    platformEventId: string | null;
};

export default function EventPicker({
    eventId,
    segment,
}: {
    eventId: string;
    /** The screen to stay on when the event changes: "team" | "operations". */
    segment: string;
}) {
    const router = useRouter();
    const { user } = useFieldSession();
    const [events, setEvents] = useState<FieldEvent[]>([]);
    const [err, setErr] = useState("");

    const bound = user?.boundEventId ?? null;

    const load = useCallback(async () => {
        try {
            const data = await judgeApi<{ events: FieldEvent[] }>("/admin/events");
            setEvents(data.events ?? []);
        } catch (e: any) {
            // A failed list is not a reason to block the screen: the event in
            // the URL still loads. Say so quietly and leave the current one.
            setErr(e.message);
        }
    }, []);

    useEffect(() => {
        if (user) void load();
    }, [user, load]);

    const current = events.find(
        (e) => e.id === eventId || e.platformEventId === eventId,
    );
    const label = (e: FieldEvent) =>
        `${e.name}${e.venue ? ` · ${e.venue}` : ""}${e.is_active ? " · active" : ""}`;

    if (bound) {
        return (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold uppercase tracking-widest text-fog">Event</span>
                <span className="rounded-lg border border-smoke bg-coal px-3 py-2 text-sm">
                    {current ? label(current) : eventId}
                </span>
                <span className="text-fog">Your account is assigned to this event.</span>
            </div>
        );
    }

    return (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor="hfg-event-picker" className="font-bold uppercase tracking-widest text-fog">
                Event
            </label>
            <select
                id="hfg-event-picker"
                // The matched event's OWN id, not the one in the URL: the
                // options are keyed by field id, and a URL carrying the platform
                // id would otherwise match no option and show the select empty
                // on an event that is perfectly well selected.
                value={current ? current.id : ""}
                onChange={(e) => {
                    if (e.target.value && e.target.value !== current?.id) {
                        router.replace(appPath(`/hyfitgames/admin/events/${e.target.value}/${segment}`));
                    }
                }}
                className="min-w-64 rounded-lg border border-smoke bg-ink px-3 py-2 text-sm outline-none focus:border-hyred"
            >
                {!current && (
                    <option value="" disabled>
                        {events.length ? "Select an event…" : "Loading events…"}
                    </option>
                )}
                {events.map((e) => (
                    <option key={e.id} value={e.id}>
                        {label(e)}
                    </option>
                ))}
            </select>
            {err && <span className="text-bad">Event list unavailable · {err}</span>}
        </div>
    );
}
