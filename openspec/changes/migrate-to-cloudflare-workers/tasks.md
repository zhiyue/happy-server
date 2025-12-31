# Tasks: Cloudflare Workers Migration

## 1. Project Setup

- [x] 1.1 Install Wrangler CLI globally (`yarn global add wrangler`)
- [x] 1.2 Initialize Wrangler project (`wrangler init`)
- [x] 1.3 Configure `wrangler.toml` with D1, KV, R2 and DO bindings
- [x] 1.4 Set up TypeScript configuration for Workers environment
- [x] 1.5 Install core dependencies:
  - [x] `hono` - Web framework
  - [x] `@hono/zod-validator` - Zod integration
  - [x] `prisma` - Prisma CLI
  - [x] `@prisma/client` - Prisma client
  - [x] `@prisma/adapter-d1` - Prisma D1 adapter
  - [x] `@cloudflare/workers-types` - TypeScript type definitions
  - [x] `@cf-wasm/photon` - Image processing
- [x] 1.6 Create `.dev.vars` for local development secrets
- [ ] 1.7 Set up Miniflare for local testing

## 2. Database Migration (Prisma + D1)

- [x] 2.1 Update Prisma schema for SQLite/D1:
  - [x] Change provider from `postgresql` to `sqlite`
  - [x] Add `driverAdapters` preview feature
  - [x] Review/update field types for SQLite compatibility (BigInt → Int)
- [ ] 2.2 Create D1 database (`wrangler d1 create happy-server-db`)
- [ ] 2.3 Generate D1 migration using `prisma migrate diff`
- [ ] 2.4 Apply migration to D1 (`wrangler d1 migrations apply`)
- [x] 2.5 Create Prisma client wrapper for Workers:
  - [x] Implement `getPrisma(env)` factory function
  - [x] Handle PrismaD1 adapter initialization
- [x] 2.6 Migrate `inTx` to `inBatch` pattern:
  - [x] Create `inBatch` utility for D1 batch operations
  - [x] Migrate `kvMutate.ts` to read-then-batch
  - [x] Migrate `sessionDelete.ts` to read-then-batch
  - [x] Migrate `friendAdd.ts` to read-then-batch
  - [x] Migrate `friendRemove.ts` to read-then-batch

## 3. Cache Layer Migration

- [ ] 3.1 Create KV namespace (`wrangler kv:namespace create CACHE`)
- [x] 3.2 Create KV wrapper module (`/sources/modules/kv/`)
- [x] 3.3 Implement cache utilities:
  - [x] `get(key)` - Get cached value
  - [x] `set(key, value, ttl)` - Set with expiration
  - [x] `delete(key)` - Delete key
  - [x] `list(prefix)` - List keys by prefix
- [ ] 3.4 Replace simpleCache (database-based) with KV wrapper

## 4. Event Bus & Pub/Sub Migration

- [ ] 4.1 Design Durable Object for event coordination
- [ ] 4.2 Create EventBus Durable Object class
- [ ] 4.3 Implement pub/sub methods:
  - [ ] `subscribe(channel, handler)`
  - [ ] `publish(channel, message)`
  - [ ] `unsubscribe(channel)`
- [x] 4.4 Update `wrangler.toml` with DO bindings
- [ ] 4.5 Implement DO event bus (new capability, no existing pub/sub to replace)

## 5. Real-time (WebSocket) Migration

- [x] 5.1 Create WebSocket Durable Object for connection management
- [x] 5.2 Implement WebSocket handling:
  - [x] Connection upgrade in Hono route
  - [x] Message routing in DO
  - [x] Connection state management
  - [x] Heartbeat/ping-pong
- [x] 5.3 Implement room/channel abstraction (replace Socket.io rooms)
- [x] 5.4 Handle disconnection and cleanup
- [ ] 5.5 Replace Socket.io code with DO WebSocket

## 6. Lock Module Migration

- [x] 6.1 Design Lock Durable Object
- [x] 6.2 Implement distributed lock:
  - [x] `acquire(lockId, ttl)`
  - [x] `release(lockId)`
  - [x] `extend(lockId, ttl)`
- [ ] 6.3 Replace process-internal AsyncLock with DO distributed locks

## 7. API Routes Migration

- [x] 7.1 Set up Hono app structure (`/sources/worker.ts`)
- [x] 7.2 Create middleware:
  - [x] CORS middleware
  - [x] Error handling middleware
  - [x] Request logging middleware
  - [x] Auth middleware (JWT validation) - `/sources/worker/middleware/auth.ts`
- [ ] 7.3 Migrate routes from Fastify to Hono:
  - [x] Auth routes (`/v1/auth/*`) - `/sources/worker/routes/v1.ts`
  - [x] Version routes (`/v1/version`) - `/sources/worker/routes/v1.ts`
  - [x] Session routes (`/v1/sessions/*`) - `/sources/worker/routes/sessions.ts`
  - [x] Machine routes (`/v1/machines/*`) - `/sources/worker/routes/machines.ts`
  - [x] KV routes (`/v1/kv/*`) - `/sources/worker/routes/kv.ts`
  - [x] User routes (`/v1/user/*`, `/v1/friends/*`) - `/sources/worker/routes/users.ts`
  - [ ] Other API routes (account, artifacts, connect, dev, feed, push, voice)
- [x] 7.4 Update Zod schemas for Hono validators (using @hono/zod-validator)
- [ ] 7.5 Create response helpers

## 8. File Storage Migration

- [ ] 8.1 Create R2 bucket (`wrangler r2 bucket create happy-server-files`)
- [ ] 8.2 Create R2 wrapper module (`/sources/modules/storage/`)
- [ ] 8.3 Implement file operations:
  - [ ] `upload(key, file)`
  - [ ] `download(key)`
  - [ ] `delete(key)`
  - [ ] `getSignedUrl(key)`
- [ ] 8.4 Migrate MinIO/S3 operations to R2

## 9. Image Processing Migration

- [x] 9.1 Install `@cf-wasm/photon` package
- [x] 9.2 Migrate `processImage.ts`:
  - [x] Replace `sharp` with `PhotonImage`
  - [x] Implement `resize()` using photon
  - [x] Implement `detectFormat()` using magic bytes
  - [x] Add memory cleanup (`.free()` calls)
- [ ] 9.3 Migrate `uploadImage.ts`:
  - [ ] Update to use new `processImage()`
  - [ ] Replace MinIO with R2
- [x] 9.4 Add image size validation (reject > 5MB for memory safety)
- [x] 9.5 Keep `thumbhash.ts` unchanged (pure JS, Workers-compatible)
- [ ] 9.6 Remove `sharp` dependency from package.json

## 10. Configuration & Secrets

- [ ] 10.1 Identify all environment variables
- [ ] 10.2 Migrate secrets to Wrangler secrets (`wrangler secret put`)
- [ ] 10.3 Update code to use `env` bindings pattern
- [ ] 10.4 Remove dotenv dependencies

## 11. Testing

- [ ] 11.1 Set up Vitest with Miniflare
- [ ] 11.2 Create test utilities for D1/KV/DO mocking
- [ ] 11.3 Migrate existing tests to Workers environment
- [ ] 11.4 Write integration tests for:
  - [ ] API endpoints
  - [ ] Database operations
  - [ ] WebSocket connections
  - [ ] Event bus
  - [ ] Image processing
- [ ] 11.5 Add E2E tests

## 12. Deployment

- [ ] 12.1 Create staging environment
- [ ] 12.2 Set up CI/CD pipeline for Workers deployment
- [ ] 12.3 Configure custom domain (if needed)
- [ ] 12.4 Create data migration scripts (PostgreSQL → D1)
- [ ] 12.5 Document deployment process

## 13. Cleanup

- [ ] 13.1 Remove Node.js-specific dependencies:
  - [ ] `sharp`
  - [ ] `ioredis`
  - [ ] `socket.io`
  - [ ] `minio`
- [ ] 13.2 Remove Dockerfile and Docker-related files
- [x] 13.3 Update Prisma schema (keep, but for sqlite)
- [x] 13.4 Update package.json scripts for Wrangler
- [ ] 13.5 Update CLAUDE.md with new development guidelines
- [ ] 13.6 Update README with Cloudflare deployment instructions
