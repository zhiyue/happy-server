import { PrismaClient } from "@prisma/client";

/**
 * Base context with user identification.
 */
export class Context {

    static create(uid: string) {
        return new Context(uid);
    }

    readonly uid: string;

    private constructor(uid: string) {
        this.uid = uid;
    }
}

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