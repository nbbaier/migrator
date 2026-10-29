# Coding standards

## Module shape
- `migrate()` is the sole export of `src/migrator.ts`. `Migrator`, `RuntimeError`
  and the helpers stay module-private (made deliberate in d676468).
- New behaviour is a method on `Migrator`. Pure helpers go at the bottom of the
  file as plain functions, in the style of `difference()` and `normaliseSql()`.

## Errors
- Throw `RuntimeError` for anything the migration refuses or cannot do safely:
  invalid schema, blocked deletion, foreign key violation. Let libsql errors
  propagate untouched.

## SQL safety
Schema SQL is user input. Every identifier interpolated into a statement goes
through `escapeIdentifier()`, every pragma through `validatePragma()`, every
value through bound args.

## Documentation
The JSDoc on `migrate()` and `Migrator` is the user-facing docs. Update it in the
same change as any behaviour it describes. Implementation code carries no
comments.

## Logging
Log through `logger` from `src/logger.ts`.

## Tests
- One flat `test()` per behaviour in `tests/index.test.ts`, named
  `migrate <does X>`.
- Each test calls `createTempDb()` and tears down in `finally` with
  `db.close()` and `rm(filePath)`.
- Assert only through `migrate()` and raw SQL queries, never internals.
- A destructive path gets two tests: refused with `allowDeletions` false,
  applied with it true.

## Changelog
`CHANGELOG.md` follows Keep a Changelog. Add an entry for any behaviour change.
