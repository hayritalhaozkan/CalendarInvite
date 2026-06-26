# Single-tenant with SQLite storage

We use SQLite as the sole data store and design for a single Admin. This eliminates all multi-tenancy concerns (row-level security, tenant isolation, connection pooling) and avoids running a separate database server. The SQLite file lives on the same disk as the application, backups are a file copy, and `better-sqlite3` gives synchronous access without connection management.

We considered PostgreSQL (scalable but operationally heavy for one user) and flat JSON files (no query capability, no transactional safety). SQLite is the sweet spot for a single-admin tool with low write concurrency.
