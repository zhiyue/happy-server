# Lock Specification

## ADDED Requirements

### Requirement: Durable Objects Distributed Locks

The application SHALL use Durable Objects for distributed locking.

#### Scenario: Lock acquisition
- **WHEN** a lock is requested for a resource
- **THEN** the request is routed to the Lock Durable Object
- **AND** the lock is granted if not held by another client
- **AND** the lock is denied or queued if already held

#### Scenario: Lock release
- **WHEN** a lock is released
- **THEN** the Durable Object marks the lock as available
- **AND** waiting clients are notified (if any)

#### Scenario: Lock timeout
- **WHEN** a lock is acquired with a TTL
- **THEN** the lock is automatically released after TTL expires
- **AND** the holding client loses exclusive access

### Requirement: Single-threaded Execution

The application SHALL leverage Durable Object's single-threaded execution for lock consistency.

#### Scenario: Concurrent lock requests
- **WHEN** multiple clients request the same lock simultaneously
- **THEN** the Durable Object processes requests sequentially
- **AND** only one client receives the lock at a time
- **AND** no race conditions occur

### Requirement: Lock Extension

The application SHALL support extending lock TTL.

#### Scenario: Extend lock
- **WHEN** a lock holder requests TTL extension
- **AND** the lock is still held by the requester
- **THEN** the lock TTL is extended
- **AND** the lock remains valid

#### Scenario: Extend expired lock
- **WHEN** a lock holder requests TTL extension
- **AND** the lock has already expired
- **THEN** the extension fails
- **AND** an error is returned

## REMOVED Requirements

### Requirement: Process-internal AsyncLock

The application SHALL NOT use the process-internal `AsyncLock` for distributed coordination.

#### Scenario: Cross-worker synchronization
- **WHEN** multiple Workers need to coordinate access to a resource
- **THEN** Durable Objects locks SHALL be used
- **AND** `AsyncLock` SHALL NOT be used (it only works within a single process)
