/**
 * Worker context types.
 *
 * This provides the WorkerContext interface without importing
 * from Node.js-specific code (like @/storage/db).
 */

import { PrismaClient } from "@prisma/client";

/**
 * Worker-specific context with access to D1 and Prisma.
 * Used in Cloudflare Workers environment where per-request instances are needed.
 */
export interface WorkerContext {
    /** User ID */
    uid: string;
    /** Prisma client for reads (created per-request) */
    prisma: PrismaClient;
    /** D1 database binding for atomic batch writes */
    db: D1Database;
}
