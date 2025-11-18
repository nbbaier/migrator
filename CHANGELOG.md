# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-11-18

### Added

#### Core Features
- **Complete 12-Step Migration Procedure**: Full implementation of David Rothlis's declarative schema migration workflow for SQLite
- **Trigger Support**: Automatic detection, migration, and recreation of triggers during table schema changes
- **View Support**: Complete view migration including detection, dropping, and recreation when tables change
- **Index Migration**: Full support for creating, updating, and removing indices
- **Transaction Safety**: All migrations wrapped in transactions with automatic rollback on error
- **Foreign Key Validation**: Validates foreign key constraints before committing migrations
- **Deletion Protection**: Prevents accidental deletion of tables and columns unless explicitly allowed via `allowDeletions=true`
- **PRAGMA Migration**: Supports migration of `foreign_keys` and `user_version` pragmas

#### Security
- **SQL Injection Prevention**: Added identifier validation and escaping for table names, column names, and index names
- **Input Validation**: Schema validation to reject dangerous SQL statements (ATTACH DATABASE, DETACH DATABASE, unsafe pragmas)
- **Pragma Whitelist**: Only allows safe, known pragmas to prevent security issues
- **Identifier Sanitization**: All SQL identifiers are properly escaped using double-quote escaping

#### Error Handling
- **Exported RuntimeError**: Custom error class now exported for proper error handling in consuming code
- **Detailed Error Messages**: Clear, actionable error messages for migration failures
- **Schema Validation Errors**: Helpful messages when schema SQL is malformed or invalid

#### Documentation
- **Comprehensive JSDoc**: Full API documentation with examples for all public exports
- **Usage Examples**: Code examples showing how to use the migrator safely
- **CLAUDE.md**: Detailed architecture and development documentation
- **README.md**: Reference to the 12-step procedure

#### Testing
- **17 Comprehensive Tests**: Full test coverage for critical functionality including:
  - Table and column addition/modification
  - Index creation, modification, and deletion
  - Trigger creation and updates
  - View creation and updates
  - Foreign key constraint validation
  - Special characters in identifiers
  - Idempotency verification
  - Error scenarios (invalid SQL, dangerous statements)
  - Deletion protection (tables and columns)
  - Complex migrations with triggers, views, and indices
  - Empty schema handling

### Changed
- **Biome Configuration**: Updated schema version to match installed version (2.2.5)

### Technical Details

#### Migration Process
The migrator creates an in-memory "pristine" database with the target schema, compares it against the current database, and generates the necessary SQL to migrate. Key steps:

1. Disable foreign keys (if enabled)
2. Start write transaction
3. Detect tables, indices, triggers, and views to add/remove/modify
4. For modified tables:
   - Remember associated triggers, indices, and views
   - Create new table with updated schema
   - Copy data from common columns
   - Drop old table
   - Rename new table
   - Recreate triggers, indices, and views
5. Migrate standalone indices, triggers, and views
6. Update pragmas (user_version, foreign_keys)
7. Validate foreign key constraints
8. Commit transaction
9. Re-enable foreign keys and run VACUUM

#### Safety Features
- All changes are atomic (transaction-based)
- Foreign keys temporarily disabled during migration
- Data preserved during table recreation
- Only common columns migrated (safe data transfer)
- Foreign key validation before commit
- Automatic rollback on any error

### Dependencies
- `@libsql/client` ^0.15.15 - SQLite/libSQL client library
- `pino` ^9.13.0 - Structured logging
- `@biomejs/biome` 2.2.5 (dev) - Linting and formatting
- `typescript` 5.9.2 (peer) - Type safety

### Known Limitations
- Does not track migration history (declarative approach means state is always current)
- Trigger and view recreation uses exact SQL from schema (no automatic adaptation)
- Very large tables may experience longer migration times due to data copying
- Log files grow unbounded (no automatic rotation configured)

### Breaking Changes
None - this is the initial release.

### Migration from Previous Versions
Not applicable - this is the first versioned release (0.1.0).

---

## [Unreleased]

### Planned Features
- Log rotation support
- Migration history tracking (optional)
- Progress reporting for large migrations
- Dry-run mode to preview changes
- Enhanced view dependency detection
- Support for more pragma types

---

[0.1.0]: https://github.com/nbbaier/migrator/releases/tag/v0.1.0
