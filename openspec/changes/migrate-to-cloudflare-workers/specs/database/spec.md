# Database Specification

## ADDED Requirements

### Requirement: D1 SQLite Database

The application SHALL use Cloudflare D1 as the primary database.

#### Scenario: Database query execution
- **WHEN** a database query is executed
- **THEN** the query runs against the D1 SQLite database
- **AND** results are returned as JavaScript objects

#### Scenario: Database binding
- **WHEN** the Worker starts
- **THEN** the D1 database is available via `env.DB` binding
- **AND** queries are executed using the Prisma D1 adapter

### Requirement: Prisma ORM with D1 Adapter

The application SHALL use Prisma ORM with the `@prisma/adapter-d1` driver.

#### Scenario: Prisma client initialization
- **WHEN** a request is handled
- **THEN** PrismaClient is instantiated with PrismaD1 adapter
- **AND** the adapter uses the D1 binding from environment

#### Scenario: Schema configuration
- **WHEN** configuring Prisma schema
- **THEN** the provider SHALL be set to `sqlite`
- **AND** the `driverAdapters` preview feature SHALL be enabled

#### Scenario: Query execution
- **WHEN** executing Prisma queries
- **THEN** the familiar Prisma API is used
- **AND** queries are translated to SQLite-compatible SQL

### Requirement: Atomic Batch Operations

The application SHALL use D1 batch API for atomic multi-statement operations.

#### Scenario: Batch write success
- **WHEN** multiple write statements are batched together
- **AND** all statements succeed
- **THEN** all changes are committed atomically

#### Scenario: Batch write failure
- **WHEN** any statement in a batch fails
- **THEN** all changes are rolled back
- **AND** no partial writes occur

#### Scenario: Read-then-batch pattern
- **WHEN** a transaction requires reads before writes
- **THEN** reads are performed first using Prisma
- **AND** writes are collected and executed as a D1 batch

### Requirement: Migration Management

The application SHALL use Prisma migrate diff with Wrangler for database migrations.

#### Scenario: Migration generation
- **WHEN** schema changes are made
- **THEN** `prisma migrate diff` generates migration SQL

#### Scenario: Migration application
- **WHEN** migrations need to be applied
- **THEN** `wrangler d1 migrations apply` executes pending migrations
- **AND** migrations are tracked in the D1 database
