# Real-time availability check instead of background sync

When a Booker loads the booking page, the server queries connected calendar APIs in real time to determine busy/free data. There is no background sync job, no cached events table, and no webhook subscriptions.

We considered periodic sync (cron pulling events into SQLite) and push via webhooks (calendar change notifications). Both add infrastructure complexity — scheduled workers, stale-cache invalidation, webhook endpoints with verification. For a single-admin tool with low traffic, a live API call per page load (under 1–2 seconds) is acceptable and guarantees accuracy. A short in-memory TTL cache (60 seconds) can be added later if needed without architectural changes.
