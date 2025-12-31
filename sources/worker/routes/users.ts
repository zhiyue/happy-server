/**
 * User and friend routes for Cloudflare Workers
 *
 * Migrated from Fastify user routes.
 * Provides user profile and friend management endpoints.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Env } from "@/worker";
import { authMiddleware, AuthVariables } from "@/worker/middleware/auth";
import { getPrisma } from "@/storage/prisma";
import { PrismaClient } from "@prisma/client";
import { WorkerContext } from "@/context";
import { buildUserProfile, UserProfile } from "@/app/social/type";
import { friendAdd } from "@/app/social/friendAdd";
import { friendRemove } from "@/app/social/friendRemove";

// RelationshipStatus enum values (matching Prisma schema)
type RelationshipStatus = "none" | "requested" | "pending" | "friend" | "rejected";
const RelationshipStatus = {
    none: "none" as const,
    requested: "requested" as const,
    pending: "pending" as const,
    friend: "friend" as const,
    rejected: "rejected" as const,
};

// Create users router
const users = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// Create friends router
const friends = new Hono<{
    Bindings: Env;
    Variables: AuthVariables;
}>();

// ==================== Types ====================

/**
 * Account data shape returned from Prisma queries.
 */
interface AccountData {
    id: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: unknown;
    githubUser: { profile: unknown } | null;
}

/**
 * Relationship data shape returned from Prisma queries.
 */
interface RelationshipData {
    fromUserId: string;
    toUserId: string;
    status: RelationshipStatus;
    toUser: AccountData;
}

// ==================== Helper Functions ====================

/**
 * Create a WorkerContext from Hono context.
 */
function createWorkerContext(userId: string, env: Env): WorkerContext {
    return {
        uid: userId,
        prisma: getPrisma(env.DB),
        db: env.DB,
    };
}

/**
 * Get list of friends for a user (Worker-compatible version).
 */
async function friendListWorker(
    prisma: PrismaClient,
    uid: string
): Promise<UserProfile[]> {
    // Query all relationships where current user is fromUserId with friend, pending, or requested status
    const relationships = await prisma.userRelationship.findMany({
        where: {
            fromUserId: uid,
            status: {
                in: [RelationshipStatus.friend, RelationshipStatus.pending, RelationshipStatus.requested],
            },
        },
        include: {
            toUser: {
                include: {
                    githubUser: true,
                },
            },
        },
    });

    // Build UserProfile objects
    return relationships.map((rel: RelationshipData) =>
        buildUserProfile(rel.toUser as Parameters<typeof buildUserProfile>[0], rel.status)
    );
}

// ==================== User Routes ====================

// GET /user/:id - Get user profile
const userIdParamSchema = z.object({
    id: z.string(),
});

users.get("/:id", authMiddleware, zValidator("param", userIdParamSchema), async (c) => {
    const userId = c.get("userId");
    const { id } = c.req.valid("param");
    const prisma = getPrisma(c.env.DB);

    // Fetch user
    const user = await prisma.account.findUnique({
        where: { id },
        include: { githubUser: true },
    });

    if (!user) {
        return c.json({ error: "User not found" }, 404);
    }

    // Resolve relationship status
    const relationship = await prisma.userRelationship.findFirst({
        where: {
            fromUserId: userId,
            toUserId: id,
        },
    });
    const status: RelationshipStatus = relationship?.status || RelationshipStatus.none;

    // Build user profile
    return c.json({
        user: buildUserProfile(user as Parameters<typeof buildUserProfile>[0], status),
    });
});

// GET /user/search - Search for users
const searchQuerySchema = z.object({
    query: z.string(),
});

users.get("/search", authMiddleware, zValidator("query", searchQuerySchema), async (c) => {
    const userId = c.get("userId");
    const { query } = c.req.valid("query");
    const prisma = getPrisma(c.env.DB);

    // Search for users by username, first 10 matches
    const searchUsers = await prisma.account.findMany({
        where: {
            username: {
                startsWith: query,
            },
        },
        include: {
            githubUser: true,
        },
        take: 10,
        orderBy: {
            username: "asc",
        },
    });

    // Resolve relationship status for each user
    const userProfiles = await Promise.all(
        searchUsers.map(async (user: AccountData) => {
            const relationship = await prisma.userRelationship.findFirst({
                where: {
                    fromUserId: userId,
                    toUserId: user.id,
                },
            });
            const status: RelationshipStatus = relationship?.status || RelationshipStatus.none;
            return buildUserProfile(user as Parameters<typeof buildUserProfile>[0], status);
        })
    );

    return c.json({
        users: userProfiles,
    });
});

// ==================== Friend Routes ====================

// POST /friends/add - Add friend
const friendActionSchema = z.object({
    uid: z.string(),
});

friends.post("/add", authMiddleware, zValidator("json", friendActionSchema), async (c) => {
    const userId = c.get("userId");
    const { uid } = c.req.valid("json");
    const ctx = createWorkerContext(userId, c.env);

    const user = await friendAdd(ctx, uid);
    return c.json({ user });
});

// POST /friends/remove - Remove friend
friends.post("/remove", authMiddleware, zValidator("json", friendActionSchema), async (c) => {
    const userId = c.get("userId");
    const { uid } = c.req.valid("json");
    const ctx = createWorkerContext(userId, c.env);

    const user = await friendRemove(ctx, uid);
    return c.json({ user });
});

// GET /friends - List friends
friends.get("/", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const prisma = getPrisma(c.env.DB);

    const friendsList = await friendListWorker(prisma, userId);
    return c.json({ friends: friendsList });
});

export { users, friends };
