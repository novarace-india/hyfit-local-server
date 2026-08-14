import { redirect } from "next/navigation";

// The field-operations control centre that lived here is now part of the single
// HYFIT admin console: Event Control is the Events screen, the Team tab is
// /admin/team, and RaceResult configuration plus the identity help desk are
// /admin/operations. This route stays as a redirect because the URL is on
// staff bookmarks and printed run sheets — deleting it outright would give a
// volunteer a 404 on an event morning.
export default function JudgeAdminRedirect() {
    redirect("/hyfitgames/admin");
}
