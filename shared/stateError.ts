// Explain a failure to WRITE app state (Lakebase), as opposed to a warehouse query.
//
// humanizeSqlError in server.ts is warehouse-oriented: a missing Lakebase endpoint
// either falls through its `not found` branch — mislabelling an app-database outage
// as a missing catalog/table — or leaks the raw driver string into the UI. Neither
// tells a user what actually happened or whether their work survived.
//
// Lives in shared/ (rather than inside server.ts) because server.ts calls createApp()
// at import time, so it cannot be imported by a unit test.

export function humanizeStateError(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err);
  // the configured Lakebase project/branch/endpoint no longer exists
  if (/NOT_FOUND/i.test(msg) && /endpoint/i.test(msg)) {
    return "the app's database is not reachable (its configured endpoint no longer exists)";
  }
  // Lakebase env vars absent — normal in local dev, where Lakebase is unset
  if (/environment variable is required|LAKEBASE_ENDPOINT|PGHOST|PGUSER/i.test(msg)) {
    return "the app's database is not configured in this environment";
  }
  if (/permission|denied|not authorized|forbidden/i.test(msg)) {
    return "the app lacks permission to write to its database";
  }
  if (/relation .* does not exist|undefined_table|42P01/i.test(msg)) {
    return "the app's database is missing a table it expects (it may need re-initialising)";
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timeout|terminated/i.test(msg)) {
    return "the app's database did not respond in time";
  }
  return "the app's database rejected the write";
}
