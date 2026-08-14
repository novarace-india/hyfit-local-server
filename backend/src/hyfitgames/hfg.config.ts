// Configuration for the HYFIT Games module. Reads from process.env with
// sensible dev fallbacks, mirroring the original standalone module's config.js.
// Kept separate from the host app's config so the module stays self-contained.

const env = (k: string, fallback: string): string => {
  const v = process.env[k];
  return v === undefined || v === '' ? fallback : v;
};

export const hfgConfig = {
  // JWT signing for the module's own athlete/admin sessions. Distinct from the
  // Novarace host app's `jose` sessions — HYFIT athletes log in with mobile+OTP.
  jwtSecret: env('HFG_JWT_SECRET', 'hfg-dev-secret-change-me'),
  accessTtl: env('HFG_ACCESS_TOKEN_TTL', '15m'),
  refreshTtlDays: parseInt(env('HFG_REFRESH_TOKEN_TTL_DAYS', '30'), 10),

  otpTtlMinutes: parseInt(env('HFG_OTP_TTL_MINUTES', '5'), 10),
  otpProvider: env('HFG_OTP_PROVIDER', 'console'), // console | msg91
  msg91AuthKey: env('MSG91_AUTH_KEY', ''),
  msg91TemplateId: env('MSG91_TEMPLATE_ID', ''),

  // Server-to-server key RaceResult14 sends as x-api-key on timing pushes.
  timingApiKey: env('TIMING_API_KEY', ''),

  isProd: process.env.NODE_ENV === 'production',
};

if (hfgConfig.isProd && hfgConfig.jwtSecret === 'hfg-dev-secret-change-me') {
  throw new Error(
    'Refusing to start in production with the default HFG_JWT_SECRET',
  );
}
