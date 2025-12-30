/**
 * Hono auth middleware for Cloudflare Workers
 *
 * Validates JWT tokens from the Authorization header and adds
 * userId and authContext to the context variables.
 */

import { createMiddleware } from "hono/factory";
import type { Env } from "@/worker";
import { createAuthContext, AuthContext } from "@/worker/auth";

/**
 * Extended context variables for authenticated requests.
 */
export interface AuthVariables {
    userId: string;
    authContext: AuthContext;
}

/**
 * Auth middleware that validates JWT tokens.
 * Use this on routes that require authentication.
 *
 * @example
 * ```typescript
 * import { authMiddleware } from "@/worker/middleware/auth";
 *
 * app.get("/v1/sessions", authMiddleware, async (c) => {
 *     const userId = c.get("userId");
 *     // ...
 * });
 * ```
 */
export const authMiddleware = createMiddleware<{
    Bindings: Env;
    Variables: AuthVariables;
}>(async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return c.json({ error: "Missing authorization header" }, 401);
    }

    const token = authHeader.substring(7);

    try {
        // Create auth context (uses CACHE KV for token caching if available)
        const authContext = await createAuthContext(c.env, c.env.CACHE);
        const verified = await authContext.verifyToken(token);

        if (!verified) {
            return c.json({ error: "Invalid token" }, 401);
        }

        // Set context variables for downstream handlers
        c.set("userId", verified.userId);
        c.set("authContext", authContext);

        await next();
    } catch {
        return c.json({ error: "Authentication failed" }, 401);
    }
});

/**
 * Optional auth middleware that sets userId if valid token is present
 * but doesn't require authentication.
 */
export const optionalAuthMiddleware = createMiddleware<{
    Bindings: Env;
    Variables: Partial<AuthVariables>;
}>(async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7);

        try {
            const authContext = await createAuthContext(c.env, c.env.CACHE);
            const verified = await authContext.verifyToken(token);

            if (verified) {
                c.set("userId", verified.userId);
                c.set("authContext", authContext);
            }
        } catch {
            // Ignore auth errors for optional auth
        }
    }

    await next();
});
