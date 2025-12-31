/**
 * Worker-compatible auth module
 *
 * This module provides JWT-based authentication for Cloudflare Workers.
 * Unlike the Node.js version, it uses environment bindings instead of process.env
 * and creates token generators/verifiers per-request since Workers are stateless.
 *
 * For performance, consider caching verified tokens in KV with short TTL.
 */

import * as privacyKit from "privacy-kit";
import type { Env } from "@/worker";

/**
 * Standalone token verifier for simple auth checks.
 * Used by WebSocket routes where full AuthContext is not needed.
 *
 * @param token - JWT token to verify
 * @param jwtSecret - The JWT secret (from env.JWT_SECRET)
 * @returns Verified token payload or null if invalid
 */
export async function verifyToken(
    token: string,
    jwtSecret: string
): Promise<{ userId: string; extras?: unknown } | null> {
    try {
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: jwtSecret,
        });

        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: "handy",
            publicKey: generator.publicKey,
        });

        const verified = await verifier.verify(token);
        if (!verified) {
            return null;
        }

        return {
            userId: verified.user as string,
            extras: verified.extras as unknown,
        };
    } catch {
        return null;
    }
}

interface TokenCacheEntry {
    userId: string;
    extras?: unknown;
}

/**
 * Per-request auth context.
 * Created once per request and reused for all auth operations.
 */
export interface AuthContext {
    verifyToken(token: string): Promise<{ userId: string; extras?: unknown } | null>;
    createToken(userId: string, extras?: unknown): Promise<string>;
    createGithubToken(userId: string): Promise<string>;
    verifyGithubToken(token: string): Promise<{ userId: string } | null>;
}

/**
 * Create an auth context for a request.
 * This initializes the token generators/verifiers with the secrets from env.
 *
 * @param env - Worker environment bindings
 * @param cache - Optional KV namespace for token caching
 */
export async function createAuthContext(env: Env, cache?: KVNamespace): Promise<AuthContext> {
    const masterSecret = env.JWT_SECRET;
    if (!masterSecret) {
        throw new Error("JWT_SECRET environment variable is required");
    }

    // Create token generator and verifier
    const generator = await privacyKit.createPersistentTokenGenerator({
        service: "handy",
        seed: masterSecret,
    });

    const verifier = await privacyKit.createPersistentTokenVerifier({
        service: "handy",
        publicKey: generator.publicKey,
    });

    // Create ephemeral GitHub token handlers
    const githubGenerator = await privacyKit.createEphemeralTokenGenerator({
        service: "github-happy",
        seed: masterSecret,
        ttl: 5 * 60 * 1000, // 5 minutes
    });

    const githubVerifier = await privacyKit.createEphemeralTokenVerifier({
        service: "github-happy",
        publicKey: githubGenerator.publicKey,
    });

    return {
        async verifyToken(token: string): Promise<{ userId: string; extras?: unknown } | null> {
            // Check KV cache first if available
            if (cache) {
                const cached = await cache.get<TokenCacheEntry>(`token:${token}`, "json");
                if (cached) {
                    return { userId: cached.userId, extras: cached.extras };
                }
            }

            try {
                const verified = await verifier.verify(token);
                if (!verified) {
                    return null;
                }

                const userId = verified.user as string;
                const extras = verified.extras as unknown;

                // Cache in KV if available (30 minute TTL)
                if (cache) {
                    await cache.put(
                        `token:${token}`,
                        JSON.stringify({ userId, extras }),
                        { expirationTtl: 1800 }
                    );
                }

                return { userId, extras };
            } catch {
                return null;
            }
        },

        async createToken(userId: string, extras?: unknown): Promise<string> {
            const payload: Record<string, unknown> = { user: userId };
            if (extras !== undefined) {
                payload.extras = extras;
            }
            return generator.new(payload);
        },

        async createGithubToken(userId: string): Promise<string> {
            return githubGenerator.new({ user: userId, extras: { purpose: "github-oauth" } });
        },

        async verifyGithubToken(token: string): Promise<{ userId: string } | null> {
            try {
                const verified = await githubVerifier.verify(token);
                if (!verified) {
                    return null;
                }
                return { userId: verified.user as string };
            } catch {
                return null;
            }
        },
    };
}
