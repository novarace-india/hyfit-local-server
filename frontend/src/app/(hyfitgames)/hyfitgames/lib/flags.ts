/* What the HYFIT athlete app is, this week.
 *
 * ATHLETE LOGIN IS OFF. Signing in is mobile + OTP, and the OTP cannot be sent
 * until the client's DLT-approved sender ID (and, for WhatsApp, an approved
 * template) exists at the gateway — see Settings → Athlete OTP in the admin
 * console. A login screen that can issue a code nobody receives is worse than
 * no login screen: every athlete who tries it is stuck on a form waiting for a
 * message that is never sent.
 *
 * So the athlete app is, for now, exactly two screens: the list of events, and
 * the leaderboard behind each one. Both are public reads that need no session
 * (`/api/hyfit-judge/public/*`), so the whole product works signed out.
 *
 * WHAT IS SWITCHED OFF, not deleted:
 *   - the athlete route guard in (app)/layout.tsx — with no way to sign in, it
 *     could only ever bounce every visitor to a login screen
 *   - the dashboard, My Journey, My Stats, Profile, scorecards and the old race
 *     hub: every one of them reads `/me/*`, which is behind that session
 *   - /hyfitgames/login itself, which redirects to the event list
 *   - the bottom nav, whose three destinations are all of the above
 *
 * TO TURN IT BACK ON: set this to `true`. Nothing else — every screen above is
 * still here, still compiled, and comes back with the flag. The admin console,
 * the judge app and the check-in app authenticate separately and are NOT
 * affected by this; their logins have never depended on OTP.
 */
export const ATHLETE_LOGIN_ENABLED = false;

/** Where a signed-out visitor belongs while login is off: the event list. */
export const PUBLIC_HOME = "/hyfitgames";
