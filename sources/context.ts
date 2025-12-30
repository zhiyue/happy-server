import { PrismaClient } from "@prisma/client";
import { db as globalDb } from "@/storage/db";

/**
 * Base context with user identification.
 * @deprecated Use WorkerContext for new code
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

/**
 * Create a WorkerContext from uid using global Prisma client.
 * Used for Node.js/Fastify environment during migration.
 *
 * NOTE: D1-specific operations (batch, prepare) will fail at runtime
 * in Node.js. This is a compatibility shim for type checking only.
 * Fastify routes should be migrated to Hono before production use.
 */
export function createNodeContext(uid: string): WorkerContext {
    return {
        uid,
        prisma: globalDb,
        // D1Database stub - will fail at runtime if D1 operations are called
        db: createD1Stub()
    };
}

/**
 * Creates a stub D1Database that throws helpful errors when used.
 * This allows Node.js code to type-check while making it clear
 * that D1 operations aren't available outside Workers.
 */
function createD1Stub(): D1Database {
    const notSupported = (method: string) => () => {
        throw new Error(
            `D1Database.${method}() is not available in Node.js environment. ` +
            `Migrate this route to Hono/Workers or use Prisma directly.`
        );
    };

    return {
        prepare: notSupported('prepare'),
        dump: notSupported('dump'),
        batch: notSupported('batch'),
        exec: notSupported('exec'),
        withSession: notSupported('withSession')
    } as unknown as D1Database;
}