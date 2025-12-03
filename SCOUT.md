# Codebase Overview - SQLite Schema Migrator

**Date:** November 20, 2025

## Project Purpose
A declarative SQLite schema migration tool that implements the 12-step procedure from [david.rothlis.net](https://david.rothlis.net/declarative-schema-migration-for-sqlite/). It safely migrates database schemas by creating new tables, transferring data, and dropping old tables within transactions.

## Architecture Overview

### Core Components
- **`src/migrator.ts`** - Main migration engine (419 lines)
  - `Migrator` class handles the 12-step migration procedure
  - `migrate()` function is the main entry point
  - Manages transactions, foreign key constraints, and schema comparisons
  - Recreates tables when schema changes are detected

- **`src/index.ts`** - Example usage (14 lines)
  - Demonstrates how to use the migrator with a local SQLite file
  - Loads schema from `./db/schema.sql` and applies to `./db/test.db`

- **`src/logger.ts`** - Structured logging (35 lines)
  - Pino-based logging with multiple outputs (console, error log, trace log)
  - Configurable log levels via `PINO_LOG_LEVEL` environment variable

### Key Features
- **Safe migrations**: Uses transactions and foreign key constraint checking
- **Data preservation**: Transfers existing data when recreating tables
- **Schema comparison**: Detects table/index changes by comparing SQL definitions
- **Deletion protection**: Refuses destructive changes unless `allowDeletions=true`
- **Comprehensive logging**: Detailed migration steps and SQL execution

### Migration Process
1. Disable foreign keys → 2. Start transaction → 3. Compare schemas → 4. Create new tables → 5. Transfer data → 6. Drop old tables → 7. Rename new tables → 8. Recreate indexes/triggers → 9. Check foreign keys → 10. Commit transaction → 11. Re-enable foreign keys → 12. Vacuum if changes made

## Development Commands
- `bun test` - Run tests
- `bun lint` - Check code style
- `bun format` - Format code
- `bun check` - Run lint + format

## First Tasks When Resuming
1. **Run tests** to ensure everything works: `bun test`
2. **Check current schema** in `db/schema.sql` - it's a simple posts table
3. **Review test cases** in `tests/index.test.ts` to understand expected behavior
4. **Try the example** by running `bun src/index.ts` to see migration in action
5. **Add your own schema** to `db/schema.sql` and test migration logic

## Key Implementation Details
- Uses `@libsql/client` for SQLite operations
- Creates in-memory pristine database for schema comparison
- Normalizes SQL for accurate comparison (removes whitespace, comments)
- Handles column additions/removals with data migration
- Supports pragma migrations (user_version, foreign_keys)
- Comprehensive error handling with transaction rollback

## Testing Approach
- Uses Bun test framework with temporary databases
- Tests cover: schema additions, data preservation, deletion protection
- Each test creates/destroys its own temporary SQLite file
- Focus on migration safety and data integrity