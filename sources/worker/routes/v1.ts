/**
 * V1 API Routes for Cloudflare Workers
 *
 * This file aggregates all v1 API routes using Hono.
 * Routes are migrated from Fastify to Hono patterns.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as semver from "semver";
import * as privacyKit from "privacy-kit";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { createAuthContext } from "@/worker/auth";
import { getPrisma } from "@/storage/prisma";
import { ANDROID_UP_TO_DATE, IOS_UP_TO_DATE } from "@/versions";
import { sessions } from "@/worker/routes/sessions";
import { machines } from "@/worker/routes/machines";
import { kv } from "@/worker/routes/kv";
import { users, friends } from "@/worker/routes/users";
import { account, usage } from "@/worker/routes/account";
import { artifacts } from "@/worker/routes/artifacts";
import { feed } from "@/worker/routes/feed";
import { push } from "@/worker/routes/push";
import { voice } from "@/worker/routes/voice";
import { accessKeys } from "@/worker/routes/accessKeys";
import { connect } from "@/worker/routes/connect";

// Create v1 router
const v1 = new Hono<{
    Bindings: Env;
    Variables: Partial<AuthVariables>;
}>();

// ==================== Version Routes ====================

const versionBodySchema = z.object({
    platform: z.string(),
    version: z.string(),
    app_id: z.string(),
});

v1.post("/version", zValidator("json", versionBodySchema), async (c) => {
    const { platform, version } = c.req.valid("json");

    // Check iOS
    if (platform.toLowerCase() === "ios") {
        if (semver.satisfies(version, IOS_UP_TO_DATE)) {
            return c.json({ updateUrl: null });
        }
        return c.json({ updateUrl: "https://apps.apple.com/us/app/happy-claude-code-client/id6748571505" });
    }

    // Check Android
    if (platform.toLowerCase() === "android") {
        if (semver.satisfies(version, ANDROID_UP_TO_DATE)) {
            return c.json({ updateUrl: null });
        }
        return c.json({ updateUrl: "https://play.google.com/store/apps/details?id=com.ex3ndr.happy" });
    }

    // Fallback
    return c.json({ updateUrl: null });
});

// ==================== Auth Routes ====================

const authBodySchema = z.object({
    publicKey: z.string(),
    challenge: z.string(),
    signature: z.string(),
});

v1.post("/auth", zValidator("json", authBodySchema), async (c) => {
    const { publicKey, challenge, signature } = c.req.valid("json");
    const tweetnacl = (await import("tweetnacl")).default;

    const publicKeyBytes = privacyKit.decodeBase64(publicKey);
    const challengeBytes = privacyKit.decodeBase64(challenge);
    const signatureBytes = privacyKit.decodeBase64(signature);

    const isValid = tweetnacl.sign.detached.verify(challengeBytes, signatureBytes, publicKeyBytes);
    if (!isValid) {
        return c.json({ error: "Invalid signature" }, 401);
    }

    // Create or update user in database
    const prisma = getPrisma(c.env.DB);
    const publicKeyHex = privacyKit.encodeHex(publicKeyBytes);
    const user = await prisma.account.upsert({
        where: { publicKey: publicKeyHex },
        update: { updatedAt: new Date() },
        create: { publicKey: publicKeyHex },
    });

    const authContext = await createAuthContext(c.env, c.env.CACHE);
    const token = await authContext.createToken(user.id);

    return c.json({ success: true, token });
});

const authRequestBodySchema = z.object({
    publicKey: z.string(),
    supportsV2: z.boolean().nullish(),
});

v1.post("/auth/request", zValidator("json", authRequestBodySchema), async (c) => {
    const { publicKey, supportsV2 } = c.req.valid("json");
    const tweetnacl = (await import("tweetnacl")).default;

    const publicKeyBytes = privacyKit.decodeBase64(publicKey);
    const isValid = tweetnacl.box.publicKeyLength === publicKeyBytes.length;
    if (!isValid) {
        return c.json({ error: "Invalid public key" }, 401);
    }

    const prisma = getPrisma(c.env.DB);
    const publicKeyHex = privacyKit.encodeHex(publicKeyBytes);

    const answer = await prisma.terminalAuthRequest.upsert({
        where: { publicKey: publicKeyHex },
        update: {},
        create: { publicKey: publicKeyHex, supportsV2: supportsV2 ?? false },
    });

    if (answer.response && answer.responseAccountId) {
        const authContext = await createAuthContext(c.env, c.env.CACHE);
        const token = await authContext.createToken(answer.responseAccountId, { session: answer.id });
        return c.json({
            state: "authorized" as const,
            token,
            response: answer.response,
        });
    }

    return c.json({ state: "requested" as const });
});

const authRequestStatusSchema = z.object({
    publicKey: z.string(),
});

v1.get("/auth/request/status", zValidator("query", authRequestStatusSchema), async (c) => {
    const { publicKey } = c.req.valid("query");
    const tweetnacl = (await import("tweetnacl")).default;

    const publicKeyBytes = privacyKit.decodeBase64(publicKey);
    const isValid = tweetnacl.box.publicKeyLength === publicKeyBytes.length;
    if (!isValid) {
        return c.json({ status: "not_found" as const, supportsV2: false });
    }

    const prisma = getPrisma(c.env.DB);
    const publicKeyHex = privacyKit.encodeHex(publicKeyBytes);
    const authRequest = await prisma.terminalAuthRequest.findUnique({
        where: { publicKey: publicKeyHex },
    });

    if (!authRequest) {
        return c.json({ status: "not_found" as const, supportsV2: false });
    }

    if (authRequest.response && authRequest.responseAccountId) {
        return c.json({ status: "authorized" as const, supportsV2: false });
    }

    return c.json({ status: "pending" as const, supportsV2: authRequest.supportsV2 });
});

const authResponseBodySchema = z.object({
    response: z.string(),
    publicKey: z.string(),
});

v1.post("/auth/response", authMiddleware, zValidator("json", authResponseBodySchema), async (c) => {
    const userId = c.get("userId")!;
    const { response, publicKey } = c.req.valid("json");
    const tweetnacl = (await import("tweetnacl")).default;

    const publicKeyBytes = privacyKit.decodeBase64(publicKey);
    const isValid = tweetnacl.box.publicKeyLength === publicKeyBytes.length;
    if (!isValid) {
        return c.json({ error: "Invalid public key" }, 401);
    }

    const prisma = getPrisma(c.env.DB);
    const publicKeyHex = privacyKit.encodeHex(publicKeyBytes);
    const authRequest = await prisma.terminalAuthRequest.findUnique({
        where: { publicKey: publicKeyHex },
    });

    if (!authRequest) {
        return c.json({ error: "Request not found" }, 404);
    }

    if (!authRequest.response) {
        await prisma.terminalAuthRequest.update({
            where: { id: authRequest.id },
            data: { response, responseAccountId: userId },
        });
    }

    return c.json({ success: true });
});

// Account auth request
const accountAuthRequestBodySchema = z.object({
    publicKey: z.string(),
});

v1.post("/auth/account/request", zValidator("json", accountAuthRequestBodySchema), async (c) => {
    const { publicKey } = c.req.valid("json");
    const tweetnacl = (await import("tweetnacl")).default;

    const publicKeyBytes = privacyKit.decodeBase64(publicKey);
    const isValid = tweetnacl.box.publicKeyLength === publicKeyBytes.length;
    if (!isValid) {
        return c.json({ error: "Invalid public key" }, 401);
    }

    const prisma = getPrisma(c.env.DB);
    const publicKeyHex = privacyKit.encodeHex(publicKeyBytes);

    const answer = await prisma.accountAuthRequest.upsert({
        where: { publicKey: publicKeyHex },
        update: {},
        create: { publicKey: publicKeyHex },
    });

    if (answer.response && answer.responseAccountId) {
        const authContext = await createAuthContext(c.env, c.env.CACHE);
        const token = await authContext.createToken(answer.responseAccountId);
        return c.json({
            state: "authorized" as const,
            token,
            response: answer.response,
        });
    }

    return c.json({ state: "requested" as const });
});

const accountAuthResponseBodySchema = z.object({
    response: z.string(),
    publicKey: z.string(),
});

v1.post("/auth/account/response", authMiddleware, zValidator("json", accountAuthResponseBodySchema), async (c) => {
    const userId = c.get("userId")!;
    const { response, publicKey } = c.req.valid("json");
    const tweetnacl = (await import("tweetnacl")).default;

    const publicKeyBytes = privacyKit.decodeBase64(publicKey);
    const isValid = tweetnacl.box.publicKeyLength === publicKeyBytes.length;
    if (!isValid) {
        return c.json({ error: "Invalid public key" }, 401);
    }

    const prisma = getPrisma(c.env.DB);
    const publicKeyHex = privacyKit.encodeHex(publicKeyBytes);
    const authRequest = await prisma.accountAuthRequest.findUnique({
        where: { publicKey: publicKeyHex },
    });

    if (!authRequest) {
        return c.json({ error: "Request not found" }, 404);
    }

    if (!authRequest.response) {
        await prisma.accountAuthRequest.update({
            where: { id: authRequest.id },
            data: { response, responseAccountId: userId },
        });
    }

    return c.json({ success: true });
});

// Mount session routes
v1.route("/sessions", sessions);

// Mount machine routes
v1.route("/machines", machines);

// Mount KV routes
v1.route("/kv", kv);

// Mount user routes
v1.route("/user", users);

// Mount friends routes
v1.route("/friends", friends);

// Mount account routes
v1.route("/account", account);

// Mount usage routes
v1.route("/usage", usage);

// Mount artifacts routes
v1.route("/artifacts", artifacts);

// Mount feed routes
v1.route("/feed", feed);

// Mount push token routes
v1.route("/push-tokens", push);

// Mount voice routes
v1.route("/voice", voice);

// Mount access keys routes
v1.route("/access-keys", accessKeys);

// Mount connect routes
v1.route("/connect", connect);

export { v1 };
