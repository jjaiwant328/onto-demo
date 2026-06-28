// Resilient postinstall.
//
// Locally (dev): run `appkit generate-types` so editor types stay fresh.
// On the Databricks Apps runtime: the app is deployed with prebuilt artifacts
// (dist/server.js + client/dist), and `npm install` runs here. We must NOT fail
// the install — typegen needs warehouse auth and is type-only (not needed at
// runtime). So: if the build already exists, skip; otherwise try typegen but
// never let a failure break `npm install`.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const alreadyBuilt = existsSync(new URL('../dist/server.js', import.meta.url));
const onAppsRuntime = Boolean(process.env.DATABRICKS_APP_NAME || process.env.DATABRICKS_APP_PORT);

if (alreadyBuilt || onAppsRuntime) {
  console.log('[postinstall] prebuilt artifacts present or running on Apps runtime — skipping typegen.');
  process.exit(0);
}

try {
  execSync('npm run typegen', { stdio: 'inherit' });
} catch {
  console.warn('[postinstall] typegen skipped (no warehouse auth available). This is fine for installs.');
}
