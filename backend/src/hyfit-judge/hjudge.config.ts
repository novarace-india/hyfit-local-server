const env = (k: string, fallback: string): string => {
  const v = process.env[k];
  return v === undefined || v === '' ? fallback : v;
};

export const hjudgeConfig = {
  sessionCookieName: 'hyfit_session',
  // Check-in signs in on its own. A counter and a judging tablet are different
  // jobs done by different people, and often on the same borrowed device — one
  // cookie meant whoever signed in last silently ended the other's shift.
  checkinCookieName: 'hyfit_checkin_session',
  // Who may open a counter. A judge PIN is refused here rather than accepted
  // into a session that 403s on every call the counter makes.
  checkinRoles: ['super_admin', 'event_admin', 'checkin'] as const,
  sessionSecret: env('HJUDGE_SESSION_SECRET', 'hjudge-dev-secret-change-me'),
  sessionMaxAgeHours: 12,

  isProd: process.env.NODE_ENV === 'production',
};
