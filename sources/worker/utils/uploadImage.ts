/**
 * Image upload utility for Cloudflare Workers.
 *
 * Handles image upload to R2 with deduplication and thumbhash generation.
 * Replaces the MinIO-based uploadImage with R2 storage.
 */

import { randomKey } from "@/worker/utils/randomKey";
import { processImage } from "@/storage/processImage";
import { getContentType } from "@/modules/storage/r2";
import { getPrisma } from "@/storage/prisma";

/**
 * Result of an image upload operation.
 */
export interface ImageUploadResult {
    /** Path to the uploaded file in R2 */
    path: string;
    /** Base64-encoded thumbhash for placeholder display */
    thumbhash: string;
    /** Original image width */
    width: number;
    /** Original image height */
    height: number;
}

/**
 * Upload an image to R2 with deduplication.
 *
 * This function:
 * 1. Checks if the image already exists (by URL hash)
 * 2. If not, processes the image for thumbhash
 * 3. Uploads to R2
 * 4. Records in database for future deduplication
 *
 * @param db - D1 database binding
 * @param files - R2 bucket binding
 * @param userId - ID of the user uploading
 * @param directory - Subdirectory within user's folder
 * @param prefix - Prefix for the filename
 * @param url - Original URL (used for deduplication)
 * @param src - Image data as Uint8Array
 * @returns Upload result with path and metadata
 */
export async function uploadImage(
    db: D1Database,
    files: R2Bucket,
    userId: string,
    directory: string,
    prefix: string,
    url: string,
    src: Uint8Array
): Promise<ImageUploadResult> {
    const prisma = getPrisma(db);

    // Check if image already exists (deduplication)
    const existing = await prisma.uploadedFile.findFirst({
        where: {
            reuseKey: "image-url:" + url,
        },
    });

    if (existing && existing.thumbhash && existing.width && existing.height) {
        return {
            path: existing.path,
            thumbhash: existing.thumbhash,
            width: existing.width,
            height: existing.height,
        };
    }

    // Process image (generate thumbhash, detect format)
    const processed = await processImage(src);
    const key = `${prefix}${randomKey(16)}`;
    const extension = processed.format === "png" ? "png" : "jpg";
    const filename = `${key}.${extension}`;
    const path = `public/users/${userId}/${directory}/${filename}`;

    // Upload to R2
    await files.put(path, src, {
        httpMetadata: {
            contentType: getContentType(filename),
        },
    });

    // Record in database for deduplication
    await prisma.uploadedFile.create({
        data: {
            accountId: userId,
            path,
            reuseKey: "image-url:" + url,
            width: processed.width,
            height: processed.height,
            thumbhash: processed.thumbhash,
        },
    });

    return {
        path,
        thumbhash: processed.thumbhash,
        width: processed.width,
        height: processed.height,
    };
}

/**
 * Get the public URL for an uploaded image.
 *
 * @param publicUrl - Base public URL for the R2 bucket
 * @param path - Path to the image in R2
 * @returns Full public URL
 */
export function resolveImageUrl(publicUrl: string, path: string): string {
    // Remove trailing slash from publicUrl if present
    const baseUrl = publicUrl.replace(/\/$/, "");
    return `${baseUrl}/${path}`;
}
