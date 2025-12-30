# Design: Cloudflare Workers Migration

## Context

Happy Server is currently built on a traditional Node.js stack:
- **Runtime**: Node.js 20
- **Framework**: Fastify 5
- **Database**: PostgreSQL + Prisma
- **Cache**: Database-based (`simpleCache` uses Prisma, not Redis)
- **Redis**: Health check only (`redis.ping()`) - minimal usage, can be removed
- **Real-time**: Socket.io
- **Locks**: Process-internal `AsyncLock` (not distributed)
- **Deployment**: Docker containers

This migration moves to Cloudflare's edge computing platform, requiring fundamental changes to how the application is structured and deployed.

## Goals / Non-Goals

### Goals
- Run the application entirely on Cloudflare Workers edge network
- Use Cloudflare's native services (D1, KV, Durable Objects, R2)
- Maintain feature parity with the current implementation
- Improve cold start performance and global latency
- Reduce operational complexity and costs

### Non-Goals
- Supporting hybrid deployment (Node.js + Workers simultaneously)
- Maintaining backward compatibility with Node.js runtime
- Keeping PostgreSQL as the primary database
- Using external Redis services

## Decisions

### 1. Web Framework: Hono

**Decision**: Use Hono as the web framework.

**Rationale**:
- Designed specifically for Cloudflare Workers
- Similar routing patterns to Fastify (easy migration)
- Built-in Zod validation support via `@hono/zod-validator`
- Excellent TypeScript support
- Small bundle size (~14KB)
- Middleware ecosystem compatible with Workers

**Alternatives Considered**:
- **itty-router**: Too minimal, lacks middleware ecosystem
- **Express-like libraries**: Too heavy, Node.js assumptions
- **Raw Workers API**: Too low-level, reinventing the wheel

### 2. Database: Cloudflare D1 + Prisma ORM

**Decision**: Use D1 with Prisma ORM via `@prisma/adapter-d1`.

**Rationale**:
- Reuse existing Prisma schema with minimal changes
- Familiar API - no need to learn new ORM
- Official Prisma support for D1 (preview)
- D1 is Cloudflare's native SQLite database with zero network latency

**Configuration Changes**:
```prisma
// schema.prisma
datasource db {
  provider = "sqlite"  // Changed from "postgresql"
  url      = "file:./dev.db"
}

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"]  // Required for D1
}
```

**Runtime Usage**:
```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaD1 } from '@prisma/adapter-d1';

export default {
    async fetch(request: Request, env: Env) {
        const adapter = new PrismaD1(env.DB);
        const prisma = new PrismaClient({ adapter });
        // Use prisma as normal
    }
};
```

**Schema Migration Strategy**:
1. Change provider from `postgresql` to `sqlite`
2. Handle PostgreSQL-specific types:

| Type | PostgreSQL | SQLite/D1 | Notes |
|------|------------|-----------|-------|
| `String` (UUID) | `uuid` | `TEXT` | ✅ Compatible |
| `Json` | `jsonb` | `TEXT` | ✅ Prisma handles serialization |
| `DateTime` | `timestamp` | `TEXT` (ISO 8601) | ✅ Compatible |
| `Bytes` | `bytea` | `BLOB` | ✅ Compatible |
| `BigInt` | `int8` | `INTEGER` | ❌ [Prisma D1 bug #23865](https://github.com/prisma/prisma/issues/23865) - 生成无效 SQL。需改用 `Int` 或 `String` |
| `enum` | Native enum | `TEXT` | ✅ Prisma handles as string |
| `@@index(sort: Desc)` | Supported | Supported | ✅ SQLite 3.3.0+ 支持 DESC 索引 |

**BigInt 迁移计划** (影响 `Account.feedSeq`, `UserFeedItem.counter`):
```prisma
// Before
feedSeq BigInt @default(0)

// After - 使用 Int（如果值范围在 32-bit 内）
feedSeq Int @default(0)

// 或使用 String（如果需要大数值）
feedSeq String @default("0")
```

3. Use `prisma migrate diff` + Wrangler for migrations

**Alternatives Considered**:
- **Drizzle ORM**: Lighter but requires rewriting all queries
- **Turso (libSQL)**: External dependency, added latency
- **Raw D1 API**: No type safety, too low-level

### 3. Cache: Cloudflare KV

**Decision**: Use Cloudflare KV for caching.

**Rationale**:
- Native Cloudflare service, no network hop
- Eventually consistent (fine for cache use cases)
- Automatic global replication
- Simple key-value API

**Migration Pattern**:
```typescript
// Before (Redis)
await redis.set('key', value, 'EX', ttl);
const cached = await redis.get('key');

// After (KV)
await env.MY_KV.put('key', value, { expirationTtl: ttl });
const cached = await env.MY_KV.get('key');
```

### 4. Pub/Sub & State: Durable Objects

**Decision**: Use Durable Objects for pub/sub and stateful operations.

**Rationale**:
- Only option for stateful coordination in Workers
- WebSocket support built-in
- Consistent, single-threaded execution per object
- Can coordinate across multiple Worker instances

**Use Cases**:
- **Event Bus**: New capability (no existing Redis pub/sub to replace)
- **Locks**: Upgrade process-internal `AsyncLock` to distributed locks using DO's single-threaded nature
- **Real-time**: WebSocket connections managed by DOs (replace Socket.io)

**Architecture**:
```
┌─────────────────┐
│  Worker (Edge)  │
└────────┬────────┘
         │ RPC
         ▼
┌─────────────────┐
│ Durable Object  │ ← Single instance per ID
│  - WebSocket    │
│  - State        │
│  - Pub/Sub      │
└─────────────────┘
```

### 5. File Storage: Cloudflare R2

**Decision**: Use R2 for file/media storage.

**Rationale**:
- S3-compatible API (easy migration from MinIO/S3)
- No egress fees
- Integrated with Workers

### 6. Authentication

**Decision**: Keep JWT-based auth, store secrets in Workers Secrets.

**Pattern**:
```typescript
// Secrets bound in wrangler.toml
export interface Env {
    JWT_SECRET: string;
    // ... other secrets
}
```

### 7. Real-time Communication: Durable Objects WebSocket

**Decision**: Replace Socket.io with Durable Objects WebSocket API.

**Rationale**:
- Socket.io requires persistent server processes (incompatible with Workers)
- Durable Objects provide WebSocket support with state persistence
- Built-in hibernation reduces costs during idle periods
- Single-threaded execution per DO ensures consistency

**Migration Strategy**:
1. Create `ConnectionManager` Durable Object for WebSocket handling
2. Implement room-based broadcasting (replaces Socket.io rooms)
3. Handle connection lifecycle: upgrade, message, close, error
4. Implement heartbeat/ping-pong for connection health
5. Use DO storage for connection state persistence

**Key Differences from Socket.io**:
| Feature | Socket.io | Durable Objects |
|---------|-----------|-----------------|
| Auto-reconnect | Built-in | Must implement client-side |
| Rooms | Native API | Custom implementation |
| Acknowledgements | Built-in | Must implement |
| Binary data | Supported | Supported |
| Fallback transports | Polling fallback | WebSocket only |

### 8. Image Processing: @cf-wasm/photon

**Decision**: Use `@cf-wasm/photon` to replace Sharp for image processing.

**Rationale**:
- Sharp uses native C++ bindings (libvips), incompatible with Workers
- Photon is Rust compiled to WebAssembly, runs natively in Workers
- Provides all required functionality: resize, metadata, raw pixel access
- Bundle size ~2.5MB (within Workers limits)

**Current Usage** (Sharp in `processImage.ts`):
```typescript
import sharp from "sharp";

export async function processImage(src: Buffer) {
    let meta = await sharp(src).metadata();
    let width = meta.width!;
    let height = meta.height!;

    const { data, info } = await sharp(src)
        .resize(targetWidth, targetHeight)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const binaryThumbHash = thumbhash(info.width, info.height, data);
    return { width, height, thumbhash, format: meta.format };
}
```

**Migrated Code** (@cf-wasm/photon):
```typescript
import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";

export async function processImage(src: Uint8Array) {
    // Load image from bytes
    const image = PhotonImage.new_from_byteslice(src);
    const width = image.get_width();
    const height = image.get_height();

    // Calculate target dimensions
    let targetWidth = 100;
    let targetHeight = 100;
    if (width > height) {
        targetHeight = Math.round(height * targetWidth / width);
    } else if (height > width) {
        targetWidth = Math.round(width * targetHeight / height);
    }

    // Resize image
    const resized = resize(image, targetWidth, targetHeight, SamplingFilter.Lanczos3);
    const data = resized.get_raw_pixels();  // Uint8Array in RGBA format

    // Generate thumbhash (pure JS, no changes needed)
    // Note: Use Uint8Array directly; avoid Node.js Buffer in Workers
    const binaryThumbHash = thumbhash(
        resized.get_width(),
        resized.get_height(),
        data  // Uint8Array works directly
    );

    // Free WASM memory
    image.free();
    resized.free();

    // Convert to base64 using Web API (btoa) instead of Buffer
    const base64Thumbhash = btoa(String.fromCharCode(...binaryThumbHash));

    return {
        width,
        height,
        thumbhash: base64Thumbhash,
        format: detectFormat(src)  // Need to implement format detection
    };
}

function detectFormat(bytes: Uint8Array): 'png' | 'jpeg' {
    // PNG magic bytes: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
    // JPEG magic bytes: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
    throw new Error('Unsupported image format');
}
```

**Memory Management**:
- Must call `.free()` on PhotonImage instances to prevent memory leaks
- Workers have 128MB memory limit; add size checks for large images

**Limitations**:
- No EXIF extraction (implement separately if needed)
- Format detection is manual (magic bytes)
- Slightly different resize algorithms (Lanczos3 vs Sharp's default)

## Transaction Migration Strategy

> **Note**: This section describes a **hybrid approach** that combines Prisma for reads with raw D1 batch for atomic writes. This is necessary because Prisma's D1 adapter does not support `$transaction()`. The Prisma API (Decision 2) is preserved for all read operations and simple writes; only multi-statement atomic writes require raw D1 batch.

### The Problem

D1 does not support traditional SQL transactions via Prisma. The current `inTx` wrapper uses `db.$transaction()` which will not work:

```typescript
// Current pattern - WILL NOT WORK on D1
await inTx(async (tx) => {
    await tx.user.create(...);
    await tx.session.create(...);  // If fails, user won't rollback
});
```

### The Solution: D1 Batch API

D1's `.batch()` method provides **atomic transactions** - all statements succeed or all roll back. However, it requires a different code pattern.

Reference: [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

### Migration Pattern

**Before (Prisma $transaction)**:
```typescript
await inTx(async (tx) => {
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) return null;
    await tx.relationship.update({ ... });
    await tx.relationship.update({ ... });
    afterTx(tx, () => sendNotification());
    return result;
});
```

**After (Read-then-Batch)**:
```typescript
// 1. Read phase (outside transaction)
const user = await prisma.user.findUnique({ where: { id } });
if (!user) return null;

// 2. Write phase (atomic batch)
const results = await env.DB.batch([
    env.DB.prepare('UPDATE relationship SET ... WHERE ...'),
    env.DB.prepare('UPDATE relationship SET ... WHERE ...'),
]);

// 3. Side effects (after successful batch)
sendNotification();
return result;
```

### Affected Code Analysis

| File | Current Pattern | Migration Strategy |
|------|----------------|-------------------|
| `kvMutate.ts` | Read keys → validate versions → batch write | ✅ Perfect fit for D1 batch |
| `sessionDelete.ts` | Verify ownership → cascade delete | ✅ D1 batch with ordered DELETEs |
| `friendAdd.ts` | Read both users → update relationships | ✅ D1 batch for dual updates |
| `friendRemove.ts` | Read both users → update relationships | ✅ D1 batch for dual updates |

### New `inBatch` Wrapper

Create a new utility to replace `inTx`:

```typescript
// sources/storage/inBatch.ts
import { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

type BatchCallback = () => void;

interface BatchContext {
    statements: D1PreparedStatement[];
    afterCallbacks: BatchCallback[];
}

export async function inBatch<T>(
    db: D1Database,
    fn: (ctx: BatchContext) => Promise<T>
): Promise<T> {
    const ctx: BatchContext = {
        statements: [],
        afterCallbacks: []
    };

    const result = await fn(ctx);

    // Execute all statements atomically
    if (ctx.statements.length > 0) {
        await db.batch(ctx.statements);
    }

    // Run after-callbacks on success
    for (const callback of ctx.afterCallbacks) {
        try {
            callback();
        } catch (e) {
            console.error('After-batch callback error:', e);
        }
    }

    return result;
}

export function addStatement(ctx: BatchContext, stmt: D1PreparedStatement) {
    ctx.statements.push(stmt);
}

export function afterBatch(ctx: BatchContext, callback: BatchCallback) {
    ctx.afterCallbacks.push(callback);
}
```

### Hybrid Approach with Prisma

Since we're using Prisma, we can combine Prisma reads with raw D1 batch writes:

```typescript
export async function friendAdd(ctx: Context, uid: string): Promise<UserProfile | null> {
    // Use Prisma for reads (type-safe, familiar API)
    const [currentUser, targetUser] = await Promise.all([
        prisma.account.findUnique({ where: { id: ctx.uid }, include: { githubUser: true } }),
        prisma.account.findUnique({ where: { id: uid }, include: { githubUser: true } })
    ]);

    if (!currentUser || !targetUser) return null;

    const [currentRel, targetRel] = await Promise.all([
        relationshipGet(prisma, currentUser.id, targetUser.id),
        relationshipGet(prisma, targetUser.id, currentUser.id)
    ]);

    // Determine what writes are needed
    const statements: D1PreparedStatement[] = [];

    if (targetRel === RelationshipStatus.requested) {
        // Accept friend request - update both to friends
        statements.push(
            env.DB.prepare('UPDATE Relationship SET status = ? WHERE fromId = ? AND toId = ?')
                .bind('friend', targetUser.id, currentUser.id),
            env.DB.prepare('UPDATE Relationship SET status = ? WHERE fromId = ? AND toId = ?')
                .bind('friend', currentUser.id, targetUser.id)
        );
    }
    // ... other cases

    // Execute all writes atomically
    if (statements.length > 0) {
        await env.DB.batch(statements);
    }

    // Notifications after successful write
    await sendFriendshipEstablishedNotification(...);

    return buildUserProfile(targetUser, RelationshipStatus.friend);
}
```

### Edge Cases

1. **Optimistic Locking (kvMutate)**: Version checks happen during read phase; if data changes between read and write, the batch succeeds but may overwrite. Consider adding version checks in the UPDATE WHERE clause.

2. **afterTx Callbacks**: These now run after batch success. No change in semantics.

3. **Retry on Conflict**: Current `inTx` retries on P2034 (transaction conflict). D1 batch doesn't have this issue since it's atomic, but consider retry logic for transient errors.

## Risks / Trade-offs

### Risk: D1 Limitations
- **Risk**: D1 has size limits (10GB) and query complexity limits
- **Mitigation**: Monitor usage, shard if needed, optimize queries

### Risk: Durable Object Cold Starts
- **Risk**: DO cold starts can add latency for first request
- **Mitigation**: Use DO hibernation API, optimize DO initialization

### Risk: No Long-Running Processes
- **Risk**: Workers have execution time limits (30s-6min depending on plan)
- **Mitigation**: Break long tasks into queue-driven steps using Cloudflare Queues

### Risk: Testing Complexity
- **Risk**: Local development differs from production
- **Mitigation**: Use Miniflare for local testing, write integration tests

### Trade-off: Eventual Consistency (KV)
- KV is eventually consistent; for strong consistency, use D1 or DO
- Cache invalidation may have propagation delays

### Trade-off: Vendor Lock-in
- Deep integration with Cloudflare services
- Migration away would require significant rewrite

## Migration Plan

### Phase 1: Project Setup
1. Initialize Wrangler project
2. Configure wrangler.toml with bindings
3. Set up local development with Miniflare
4. Create D1 database and KV namespaces

### Phase 2: Core Infrastructure
1. Set up Hono with middleware (CORS, logging, error handling)
2. Update Prisma schema for SQLite/D1 compatibility
3. Create D1 migrations using `prisma migrate diff`
4. Implement KV cache wrapper

### Phase 3: Feature Migration
1. Migrate API routes (Fastify → Hono)
2. Update database queries for D1 compatibility (Prisma API unchanged)
3. Migrate cache operations (Redis → KV)
4. Implement Durable Objects for:
   - WebSocket connections (replace Socket.io)
   - Event bus (replace Redis pub/sub)
   - Distributed locks

### Phase 4: Testing & Validation
1. Write integration tests with Miniflare
2. Test all API endpoints
3. Test real-time functionality
4. Performance benchmarking

### Phase 5: Deployment
1. Deploy to Cloudflare Workers (staging)
2. Run migration scripts for data
3. Validate in staging environment
4. Deploy to production
5. Monitor and iterate

### Rollback Strategy
- Keep Node.js version deployable until stable
- Feature flag for gradual rollout if needed
- Database migration is one-way; maintain backups

## Resolved Questions

1. **图片处理**: ✅ 使用 `@cf-wasm/photon` 替代 Sharp（详见 Decision 7）。
   - 支持 resize、获取宽高、raw pixels
   - Bundle ~2.5MB，符合 Workers 限制
   - 注意：大图片需要内存限制检查（Workers 128MB limit）
   - 备选：如需更复杂图片处理，可使用 Cloudflare Containers 运行原生 Sharp

2. **视频处理 (FFmpeg)**: ✅ 无需迁移。代码中未使用 FFmpeg，仅在 Dockerfile 中预装。
   - 如未来需要视频处理，可选方案：
     - **Cloudflare Containers** (推荐): 2025年6月公开 Beta，可运行 Docker 镜像（含 FFmpeg），按 10ms 计费，最高 4GB RAM
     - Cloudflare Stream: 托管视频服务
     - 外部服务: AWS Lambda/专用服务器

## Open Questions

1. **Data Migration**: How to migrate existing PostgreSQL data to D1?
   - Export as SQL/CSV
   - Write migration script
   - Consider data transformation needs (PostgreSQL types → SQLite types)

2. **Prisma D1 Maturity**: Prisma D1 adapter is in preview. Monitor for:
   - Performance issues
   - Missing features
   - Breaking changes in updates
