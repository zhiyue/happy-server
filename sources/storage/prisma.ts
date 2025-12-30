/**
 * Prisma client wrapper for Cloudflare Workers + D1
 *
 * This module provides a factory function to create Prisma clients
 * that work with Cloudflare D1 database using the @prisma/adapter-d1.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";

/**
 * Creates a Prisma client configured for D1 database.
 *
 * The client is created per-request since Workers are stateless and
 * each request may be handled by a different isolate.
 *
 * @param db - The D1 database binding from the Worker environment
 * @returns A configured PrismaClient instance
 */
export function getPrisma(db: D1Database): PrismaClient {
    const adapter = new PrismaD1(db);
    return new PrismaClient({ adapter });
}

/**
 * Type for the Prisma client used throughout the application.
 * This is the same as the standard PrismaClient but configured for D1.
 */
export type DB = PrismaClient;
