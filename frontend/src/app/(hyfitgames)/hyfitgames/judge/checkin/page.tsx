import { redirect } from "next/navigation";

// Check-in moved out of the judge app and became its own: /hyfitgames/checkin,
// with its own sign-in and its own session. This path stays because it is
// bookmarked on counter tablets and printed on volunteer instructions — the
// people who need it are the least able to be told about a new URL mid-event.
export default function MovedCheckin() {
  redirect("/hyfitgames/checkin");
}
