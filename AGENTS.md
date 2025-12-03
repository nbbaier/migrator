# AGENTS.md

## Commands
- **Test**: `bun test` (single test: `bun test test-name`)
- **Lint**: `bun lint`
- **Format**: `bun format`
- **Check**: `bun check` (lint + format)

## Code Style
- **TypeScript**: Strict mode enabled, ESNext target
- **Formatting**: Biome with tabs, double quotes
- **Imports**: Organized automatically by Biome
- **Error handling**: Use custom `RuntimeError` class for migration errors
- **Naming**: camelCase for functions/variables, PascalCase for classes
- **Comments**: Avoid unless explicitly requested

## Architecture
- **Core**: `src/migrator.ts` - main migration engine
- **Entry**: `src/index.ts` - example usage
- **Logging**: `src/logger.ts` - pino structured logging
- **Tests**: `tests/index.test.ts` - Bun test framework