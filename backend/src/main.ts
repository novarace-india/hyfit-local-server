import * as path from 'path';
import * as dotenv from 'dotenv';

// Anchor the .env lookup to this compiled file rather than the process cwd, so
// `node dist/main` works from any directory. __dirname is backend/dist, so
// ../.env resolves to backend/.env.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// The Novarace bootstrap also pulls DB credentials from AWS Secrets Manager
// before importing the app. This build is for running HYFIT locally against a
// database you configure in .env, so there is no secrets fetch — the deferred
// import of server.js is kept anyway, since env has to be fully populated
// before Nest's module decorators evaluate (hfg.config / hjudge.config read
// process.env at module load and refuse dev secrets in production).
async function bootstrap() {
  const { bootstrap } = await import('./server.js');
  await bootstrap();
}

bootstrap().catch((error) => {
  console.error('Fatal error during application bootstrap', error);
  process.exit(1);
});
