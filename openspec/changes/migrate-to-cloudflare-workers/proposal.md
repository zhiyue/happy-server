# Change: Migrate to Cloudflare Workers

## Why

The current Node.js + Fastify architecture requires traditional server infrastructure with manual scaling, maintenance, and higher operational costs. Migrating to Cloudflare Workers provides:

- **Edge-first deployment**: Run code in 300+ global locations with sub-10ms cold starts
- **Zero infrastructure management**: No servers, containers, or orchestration to maintain
- **Cost efficiency**: Pay only for actual compute time, no idle server costs
- **Integrated ecosystem**: D1 (SQLite), KV, Durable Objects, R2 all work seamlessly together
- **Simplified operations**: No need to manage Redis clusters, PostgreSQL instances, or load balancers

## What Changes

### **BREAKING** - Runtime Environment
- FROM: Node.js 20 runtime
- TO: Cloudflare Workers (V8 isolates)
- Impact: Some Node.js APIs unavailable, must use Web APIs

### **BREAKING** - Web Framework
- FROM: Fastify 5
- TO: Hono (lightweight, Cloudflare-native)
- Impact: Route definitions change, middleware patterns differ

### **BREAKING** - Database
- FROM: PostgreSQL + Prisma ORM
- TO: Cloudflare D1 (SQLite-based) + Drizzle ORM
- Impact: Schema migration required, some PostgreSQL-specific features unavailable

### **BREAKING** - Cache & Pub/Sub
- FROM: Redis (ioredis)
- TO: Cloudflare KV (cache) + Durable Objects (pub/sub state)
- Impact: Different API patterns, eventual consistency for KV

### **BREAKING** - Real-time Communication
- FROM: Socket.io
- TO: Durable Objects with WebSocket API
- Impact: Different connection management, no automatic reconnection library

### Configuration & Deployment
- FROM: Docker multi-stage build
- TO: Wrangler CLI deployment
- Impact: New deployment pipeline, environment configuration changes

## Impact

### Affected Specs
- `runtime` - New runtime environment specification
- `database` - New database layer specification
- `cache` - New caching layer specification
- `realtime` - New real-time communication specification
- `api` - Updated API framework specification

### Affected Code
- All source files in `/sources` require review/rewrite
- `/prisma` schema → Drizzle schema migration
- `/Dockerfile` → `wrangler.toml`
- Environment variable handling → Cloudflare secrets/bindings
- All Redis-dependent code → KV/Durable Objects

### External Dependencies Removed
- PostgreSQL database service
- Redis service
- Container orchestration (Docker/K8s)

### External Dependencies Added
- Cloudflare Workers account
- Cloudflare D1 database
- Cloudflare KV namespace
- Cloudflare Durable Objects (if needed for stateful operations)
- Cloudflare R2 (for file storage, replacing local file system)
