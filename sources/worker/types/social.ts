/**
 * Worker-compatible social types.
 *
 * These types match the original @/app/social/type.ts but without
 * Node.js-specific dependencies (minio, fastify).
 */

/**
 * Relationship status values (matching Prisma schema enum).
 * SQLite/D1 stores enums as strings, so we define them here.
 */
export type RelationshipStatus = "none" | "requested" | "pending" | "friend" | "rejected";
export const RelationshipStatus = {
    none: "none" as const,
    requested: "requested" as const,
    pending: "pending" as const,
    friend: "friend" as const,
    rejected: "rejected" as const,
};

/**
 * Image reference stored in database JSON fields.
 */
export interface ImageRef {
    path: string;
    width?: number;
    height?: number;
    thumbhash?: string;
}

/**
 * GitHub profile data structure.
 */
export interface GitHubProfile {
    id: number;
    login: string;
    type: string;
    site_admin: boolean;
    name: string | null;
    company: string | null;
    blog: string | null;
    location: string | null;
    email: string | null;
    hireable: boolean | null;
    bio: string | null;
    twitter_username: string | null;
    public_repos: number;
    public_gists: number;
    followers: number;
    following: number;
    created_at: string;
    updated_at: string;
    avatar_url: string;
}

/**
 * User profile returned by friend/user APIs.
 */
export interface UserProfile {
    id: string;
    firstName: string;
    lastName: string | null;
    avatar: {
        path: string;
        url: string;
        width?: number;
        height?: number;
        thumbhash?: string;
    } | null;
    username: string;
    bio: string | null;
    status: RelationshipStatus;
}

/**
 * Build a user profile from account data.
 *
 * @param account - Account with optional github user
 * @param status - Relationship status
 * @param filesPublicUrl - Public URL base for files (from env.FILES_PUBLIC_URL)
 */
export function buildUserProfile(
    account: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: ImageRef | null;
        githubUser?: { profile: GitHubProfile } | null;
    },
    status: RelationshipStatus,
    filesPublicUrl?: string
): UserProfile {
    const githubProfile = account.githubUser?.profile;
    const avatarJson = account.avatar;

    let avatar: UserProfile["avatar"] = null;
    if (avatarJson) {
        const avatarData = avatarJson;
        const baseUrl = filesPublicUrl?.replace(/\/$/, "") || "";
        avatar = {
            path: avatarData.path,
            url: baseUrl ? `${baseUrl}/${avatarData.path}` : avatarData.path,
            width: avatarData.width,
            height: avatarData.height,
            thumbhash: avatarData.thumbhash,
        };
    }

    return {
        id: account.id,
        firstName: account.firstName || "",
        lastName: account.lastName,
        avatar,
        username: account.username || githubProfile?.login || "",
        bio: githubProfile?.bio || null,
        status,
    };
}
