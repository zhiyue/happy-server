# Tasks: Cloudflare Workers Migration

## 1. Project Setup

- [ ] 1.1 Install Wrangler CLI globally (`npm install -g wrangler`)
- [ ] 1.2 Initialize Wrangler project (`wrangler init`)
- [ ] 1.3 Configure `wrangler.toml` with D1, KV, and DO bindings
- [ ] 1.4 Set up TypeScript configuration for Workers environment
- [ ] 1.5 Install core dependencies:
  - [ ] `hono` - Web framework
  - [ ] `@hono/zod-validator` - Zod integration
  - [ ] `drizzle-orm` - ORM
  - [ ] `drizzle-kit` - Migrations
- [ ] 1.6 Create `.dev.vars` for local development secrets
- [ ] 1.7 Set up Miniflare for local testing

## 2. Database Migration

- [ ] 2.1 Export current Prisma schema
- [ ] 2.2 Create Drizzle schema directory (`/sources/db/schema/`)
- [ ] 2.3 Convert Prisma models to Drizzle tables:
  - [ ] Handle UUID → TEXT conversion
  - [ ] Handle JSONB → TEXT with JSON type
  - [ ] Handle timestamps → INTEGER/TEXT
  - [ ] Handle relations and foreign keys
- [ ] 2.4 Create D1 database (`wrangler d1 create happy-server-db`)
- [ ] 2.5 Generate initial migration (`drizzle-kit generate`)
- [ ] 2.6 Apply migration to D1 (`wrangler d1 migrations apply`)
- [ ] 2.7 Create database client wrapper (`/sources/db/client.ts`)
- [ ] 2.8 Implement transaction wrapper for D1

## 3. Cache Layer Migration

- [ ] 3.1 Create KV namespace (`wrangler kv:namespace create CACHE`)
- [ ] 3.2 Create KV wrapper module (`/sources/modules/kv/`)
- [ ] 3.3 Implement cache utilities:
  - [ ] `get(key)` - Get cached value
  - [ ] `set(key, value, ttl)` - Set with expiration
  - [ ] `delete(key)` - Delete key
  - [ ] `list(prefix)` - List keys by prefix
- [ ] 3.4 Replace Redis cache calls with KV wrapper

## 4. Event Bus & Pub/Sub Migration

- [ ] 4.1 Design Durable Object for event coordination
- [ ] 4.2 Create EventBus Durable Object class
- [ ] 4.3 Implement pub/sub methods:
  - [ ] `subscribe(channel, handler)`
  - [ ] `publish(channel, message)`
  - [ ] `unsubscribe(channel)`
- [ ] 4.4 Update `wrangler.toml` with DO bindings
- [ ] 4.5 Replace Redis pub/sub with DO event bus

## 5. Real-time (WebSocket) Migration

- [ ] 5.1 Create WebSocket Durable Object for connection management
- [ ] 5.2 Implement WebSocket handling:
  - [ ] Connection upgrade in Hono route
  - [ ] Message routing in DO
  - [ ] Connection state management
  - [ ] Heartbeat/ping-pong
- [ ] 5.3 Implement room/channel abstraction (replace Socket.io rooms)
- [ ] 5.4 Handle disconnection and cleanup
- [ ] 5.5 Replace Socket.io code with DO WebSocket

## 6. Lock Module Migration

- [ ] 6.1 Design Lock Durable Object
- [ ] 6.2 Implement distributed lock:
  - [ ] `acquire(lockId, ttl)`
  - [ ] `release(lockId)`
  - [ ] `extend(lockId, ttl)`
- [ ] 6.3 Replace Redis-based locks with DO locks

## 7. API Routes Migration

- [ ] 7.1 Set up Hono app structure (`/sources/app/worker.ts`)
- [ ] 7.2 Create middleware:
  - [ ] CORS middleware
  - [ ] Error handling middleware
  - [ ] Request logging middleware
  - [ ] Auth middleware (JWT validation)
- [ ] 7.3 Migrate routes from Fastify to Hono:
  - [ ] Auth routes (`/v1/auth/*`)
  - [ ] Session routes (`/v1/sessions/*`)
  - [ ] Machine routes (`/v1/machines/*`)
  - [ ] Other API routes
- [ ] 7.4 Update Zod schemas for Hono validators
- [ ] 7.5 Create response helpers

## 8. File Storage Migration

- [ ] 8.1 Create R2 bucket (`wrangler r2 bucket create happy-server-files`)
- [ ] 8.2 Create R2 wrapper module (`/sources/modules/storage/`)
- [ ] 8.3 Implement file operations:
  - [ ] `upload(key, file)`
  - [ ] `download(key)`
  - [ ] `delete(key)`
  - [ ] `getSignedUrl(key)`
- [ ] 8.4 Migrate local file operations to R2

## 9. Media Processing

- [ ] 9.1 Evaluate Cloudflare Stream for video processing
- [ ] 9.2 Evaluate Cloudflare Images for image processing
- [ ] 9.3 Design fallback strategy for unsupported operations
- [ ] 9.4 Implement media module with Workers-compatible approach

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
- [ ] 11.5 Add E2E tests

## 12. Deployment

- [ ] 12.1 Create staging environment
- [ ] 12.2 Set up CI/CD pipeline for Workers deployment
- [ ] 12.3 Configure custom domain (if needed)
- [ ] 12.4 Create data migration scripts
- [ ] 12.5 Document deployment process

## 13. Cleanup

- [ ] 13.1 Remove Node.js-specific dependencies
- [ ] 13.2 Remove Dockerfile and Docker-related files
- [ ] 13.3 Remove Prisma files
- [ ] 13.4 Update package.json scripts
- [ ] 13.5 Update CLAUDE.md with new development guidelines
- [ ] 13.6 Update README with Cloudflare deployment instructions
