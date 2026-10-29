# migrator

Declarative SQLite schema migration. `migrate(db, schema, allowDeletions)` in
`src/migrator.ts` diffs a target schema against the live database and recreates
what differs inside one transaction. Behaviour is documented in the JSDoc on
`migrate()` and `Migrator`; `python/migrator.py` is the original this ports.

## Gotchas
- `src/index.ts` runs a migration against `db/test.db` on import, and it is the
  `module` entry in `package.json`. The library is `src/migrator.ts`.
- `bun test <name>` filters by file path. One test: `bun test -t "<pattern>"`.

## Before editing `src/` or `tests/`
Read `CODING_STANDARDS.md`.

## Done means
`bun check` and `bun test` pass.
