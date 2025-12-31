/**
 * Connect routes for Cloudflare Workers
 *
 * Migrated from Fastify connect routes.
 * Provides GitHub OAuth, vendor token management, and webhook handling.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";
import { createAuthContext } from "@/worker/auth";

// Create connect router
const connect = new Hono<{
    Bindings: Env;
    Variables: Partial<AuthVariables>;
}>();

// ==================== Types ====================

interface GitHubProfile {
    login: string;
    id: number;
    avatar_url: string;
    name: string | null;
    email: string | null;
}

// ==================== Helper Functions ====================

/**
 * Simple encryption for vendor tokens using Web Crypto API.
 * Uses AES-GCM with a key derived from the master secret.
 *
 * Note: In a production environment, consider using a more robust key derivation scheme.
 */
async function encryptToken(env: Env, userId: string, vendor: string, token: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const masterSecret = env.HANDY_MASTER_SECRET || env.JWT_SECRET;

    // Derive a key from the master secret + user + vendor context
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        encoder.encode(masterSecret),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    const salt = encoder.encode(`happy-server:${userId}:${vendor}`);
    const key = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );

    // Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode(token)
    );

    // Combine IV + encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv);
    result.set(new Uint8Array(encrypted), iv.length);

    return result;
}

/**
 * Decrypt vendor token.
 */
async function decryptToken(env: Env, userId: string, vendor: string, encrypted: Uint8Array): Promise<string> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const masterSecret = env.HANDY_MASTER_SECRET || env.JWT_SECRET;

    // Derive the same key
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        encoder.encode(masterSecret),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );

    const salt = encoder.encode(`happy-server:${userId}:${vendor}`);
    const key = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 100000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );

    // Extract IV and encrypted data
    const iv = encrypted.slice(0, 12);
    const data = encrypted.slice(12);

    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        data
    );

    return decoder.decode(decrypted);
}

/**
 * Verify GitHub webhook signature.
 */
async function verifyGitHubSignature(
    secret: string,
    payload: string,
    signature: string
): Promise<boolean> {
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const expectedSig = "sha256=" + Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    return expectedSig === signature;
}

// ==================== GitHub OAuth Routes ====================

// GET /connect/github/params - Get GitHub OAuth URL
connect.get("/github/params", authMiddleware, async (c) => {
    const userId = c.get("userId")!;
    const clientId = c.env.GITHUB_CLIENT_ID;
    const redirectUri = c.env.GITHUB_REDIRECT_URL;

    if (!clientId || !redirectUri) {
        return c.json({ error: "GitHub OAuth not configured" }, 400);
    }

    // Generate ephemeral state token
    const authContext = await createAuthContext(c.env, c.env.CACHE);
    const state = await authContext.createGithubToken(userId);

    // Build complete OAuth URL
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "read:user,user:email,read:org,codespace",
        state: state,
    });

    const url = `https://github.com/login/oauth/authorize?${params.toString()}`;

    return c.json({ url });
});

// GET /connect/github/callback - GitHub OAuth callback
const githubCallbackSchema = z.object({
    code: z.string(),
    state: z.string(),
});

connect.get("/github/callback", zValidator("query", githubCallbackSchema), async (c) => {
    const { code, state } = c.req.valid("query");

    // Verify the state token to get userId
    const authContext = await createAuthContext(c.env, c.env.CACHE);
    const tokenData = await authContext.verifyGithubToken(state);
    if (!tokenData) {
        return c.redirect("https://app.happy.engineering?error=invalid_state");
    }

    const userId = tokenData.userId;
    const clientId = c.env.GITHUB_CLIENT_ID;
    const clientSecret = c.env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        return c.redirect("https://app.happy.engineering?error=server_config");
    }

    // Exchange code for access token
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code: code,
        }),
    });

    const tokenResponseData = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
    };

    if (tokenResponseData.error) {
        return c.redirect(
            `https://app.happy.engineering?error=${encodeURIComponent(tokenResponseData.error)}`
        );
    }

    const accessToken = tokenResponseData.access_token;

    // Get user info from GitHub
    const userResponse = await fetch("https://api.github.com/user", {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
        },
    });

    const userData = (await userResponse.json()) as GitHubProfile;

    if (!userResponse.ok) {
        return c.redirect("https://app.happy.engineering?error=github_user_fetch_failed");
    }

    // Store GitHub user data
    const prisma = getPrisma(c.env.DB);

    await prisma.githubUser.upsert({
        where: { githubId: userData.id },
        update: {
            accountId: userId,
            login: userData.login,
            profile: userData as unknown as object,
            accessToken: accessToken!,
            updatedAt: new Date(),
        },
        create: {
            githubId: userData.id,
            accountId: userId,
            login: userData.login,
            profile: userData as unknown as object,
            accessToken: accessToken!,
        },
    });

    // Redirect to app with success
    return c.redirect(
        `https://app.happy.engineering?github=connected&user=${encodeURIComponent(userData.login)}`
    );
});

// POST /connect/github/webhook - GitHub webhook handler
connect.post("/github/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const eventName = c.req.header("x-github-event");

    if (!signature || !eventName) {
        return c.json({ error: "Missing required headers" }, 400);
    }

    const webhookSecret = c.env.GITHUB_WEBHOOK_SECRET;
    if (!webhookSecret) {
        return c.json({ error: "Webhooks not configured" }, 500);
    }

    const rawBody = await c.req.text();

    // Verify signature
    const isValid = await verifyGitHubSignature(webhookSecret, rawBody, signature);
    if (!isValid) {
        return c.json({ error: "Invalid signature" }, 401);
    }

    // TODO: Handle specific webhook events
    // For now, just acknowledge receipt

    return c.json({ received: true });
});

// DELETE /connect/github - Disconnect GitHub
connect.delete("/github", authMiddleware, async (c) => {
    const userId = c.get("userId")!;
    const prisma = getPrisma(c.env.DB);

    await prisma.githubUser.deleteMany({
        where: { accountId: userId },
    });

    return c.json({ success: true });
});

// ==================== Vendor Token Routes ====================

// POST /connect/:vendor/register - Register vendor token
const vendorParamSchema = z.object({
    vendor: z.enum(["openai", "anthropic", "gemini"]),
});

const registerTokenSchema = z.object({
    token: z.string(),
});

connect.post(
    "/:vendor/register",
    authMiddleware,
    zValidator("param", vendorParamSchema),
    zValidator("json", registerTokenSchema),
    async (c) => {
        const userId = c.get("userId")!;
        const { vendor } = c.req.valid("param");
        const { token } = c.req.valid("json");
        const prisma = getPrisma(c.env.DB);

        // Encrypt the token
        const encrypted = await encryptToken(c.env, userId, vendor, token);

        await prisma.serviceAccountToken.upsert({
            where: { accountId_vendor: { accountId: userId, vendor } },
            update: { updatedAt: new Date(), token: encrypted },
            create: { accountId: userId, vendor, token: encrypted },
        });

        return c.json({ success: true });
    }
);

// GET /connect/:vendor/token - Get vendor token
connect.get(
    "/:vendor/token",
    authMiddleware,
    zValidator("param", vendorParamSchema),
    async (c) => {
        const userId = c.get("userId")!;
        const { vendor } = c.req.valid("param");
        const prisma = getPrisma(c.env.DB);

        const tokenRecord = await prisma.serviceAccountToken.findUnique({
            where: { accountId_vendor: { accountId: userId, vendor } },
            select: { token: true },
        });

        if (!tokenRecord) {
            return c.json({ token: null });
        }

        // Decrypt the token
        const decrypted = await decryptToken(c.env, userId, vendor, tokenRecord.token);

        return c.json({ token: decrypted });
    }
);

// DELETE /connect/:vendor - Delete vendor token
connect.delete(
    "/:vendor",
    authMiddleware,
    zValidator("param", vendorParamSchema),
    async (c) => {
        const userId = c.get("userId")!;
        const { vendor } = c.req.valid("param");
        const prisma = getPrisma(c.env.DB);

        await prisma.serviceAccountToken.deleteMany({
            where: { accountId: userId, vendor },
        });

        return c.json({ success: true });
    }
);

// GET /connect/tokens - Get all vendor tokens
connect.get("/tokens", authMiddleware, async (c) => {
    const userId = c.get("userId")!;
    const prisma = getPrisma(c.env.DB);

    const tokens = await prisma.serviceAccountToken.findMany({
        where: { accountId: userId },
    });

    const decrypted = await Promise.all(
        tokens.map(async (token) => ({
            vendor: token.vendor,
            token: await decryptToken(c.env, userId, token.vendor, token.token),
        }))
    );

    return c.json({ tokens: decrypted });
});

export { connect };
