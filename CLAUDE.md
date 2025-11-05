# CLAUDE.md

## Project Overview

**migrator** is a declarative schema migration tool for SQLite databases. It implements a safe, transaction-based approach to evolving SQLite schemas by comparing a target schema against the current database state and applying necessary migrations.

The tool follows [David Rothlis's declarative schema migration workflow](https://david.rothlis.net/declarative-schema-migration-for-sqlite/), implementing the 12-step procedure for safely migrating SQLite databases.

## Key Concepts

### Declarative Approach
Rather than writing imperative migration scripts, you define the desired end state of your schema. The migrator:
1. Creates a pristine in-memory database with the target schema
2. Compares it against the current database state
3. Generates and executes the necessary SQL to migrate

### Safety Features
- **Foreign key handling**: Temporarily disables foreign keys during migration, re-enables after
- **Transaction safety**: All changes wrapped in a transaction that rolls back on error
- **Deletion protection**: Refuses to delete tables/columns unless `allowDeletions=true`
- **Foreign key validation**: Checks foreign key constraints before committing

## Architecture

### Core Files

- **src/migrator.ts** (419 lines): The heart of the migration engine
  - `migrate()` function: Main entry point
  - `Migrator` class: Handles the full migration lifecycle
  - Implements the 12-step procedure for SQLite migrations

- **src/index.ts** (14 lines): Example usage/entry point
  - Demonstrates how to use the migrator
  - Reads schema from `db/schema.sql`
  - Connects to `db/test.db`

- **src/logger.ts** (35 lines): Structured logging configuration
  - Uses `pino` for structured logging
  - Outputs to console (pretty-printed) and log files
  - Configurable via `PINO_LOG_LEVEL` env var

- **tests/index.test.ts**: Test suite

### Dependencies

- **@libsql/client**: SQLite/libSQL client library
- **pino**: Structured logging
- **Bun**: Runtime and test framework
- **Biome**: Linting and formatting
- **TypeScript**: Type safety

## Migration Process

The `Migrator` class orchestrates migrations through these phases:

1. **Initialization** (`ensurePristine`): Creates in-memory database with target schema
2. **Transaction Start** (`begin`): Disables foreign keys, starts write transaction
3. **Schema Comparison** (`performMigration`):
   - Compares tables between pristine and current schemas
   - Identifies new, removed, and modified tables
   - Handles table recreation for schema changes
   - Manages indices creation/deletion/updates
   - Migrates pragma settings (user_version, foreign_keys)
4. **Validation**: Checks foreign key constraints
5. **Commit/Rollback**: Commits if successful, rolls back on error
6. **Cleanup** (`afterCommit`): Re-enables foreign keys, runs VACUUM if changes made

### Table Recreation Process

When a table schema changes, the migrator:
1. Creates a new table with suffix `_migration_new`
2. Identifies common columns between old and new schemas
3. Copies data from common columns
4. Drops the old table
5. Renames the new table to the original name

## Development Guidelines

### Code Style
- Uses Biome for formatting and linting
- TypeScript strict mode
- Functional programming style with helper functions (difference, intersection, etc.)

### Running Commands
```bash
bun test          # Run tests
bun lint          # Lint code
bun format        # Format code
bun check         # Lint and format
```

### Logging
The project uses structured logging with pino:
- Log levels: trace, info, warn, error
- Info logs: pretty-printed to console
- Error logs: written to `./logs/error.log`
- All logs: written to `./logs/all.log`

## Common Patterns

### Error Handling
- Custom `RuntimeError` class for migration-specific errors
- Transactions automatically rollback on error
- Foreign keys re-enabled even on failure

### SQL Normalization
The `normaliseSql()` function normalizes SQL for comparison:
- Removes comments
- Normalizes whitespace
- Removes unnecessary quotes
- Used to detect schema changes

### Utility Functions
- `difference()`: Set difference for Maps
- `differenceFromSet()`: Set difference for Sets
- `intersection()`: Set intersection
- `dedent()`: Removes common indentation
- `leftPad()`: Adds indentation to all lines
- `escapeRegex()`: Escapes regex special characters

## Testing

Tests are written using Bun's built-in test framework. Run with `bun test`.

## Important Notes

1. **Table and column deletions are blocked by default** - Set `allowDeletions=true` to allow
2. **Foreign keys are temporarily disabled** during migration for safety
3. **All migrations run in a transaction** - atomic success or rollback
4. **VACUUM runs after successful migrations** to optimize database
5. **sqlite_sequence table is excluded** from migration operations

## Extension Points

To extend the migrator:
- Add custom schema validation in `performMigration()`
- Implement additional pragma migrations in `migratePragma()`
- Add custom logging by extending the logger
- Implement pre/post migration hooks by extending the Migrator class
