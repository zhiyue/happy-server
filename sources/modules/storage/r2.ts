/**
 * R2 Storage Module
 *
 * Provides a clean interface for file storage using Cloudflare R2.
 * Replaces MinIO/S3 client with native R2 bindings.
 */

/**
 * Options for uploading a file to R2.
 */
export interface UploadOptions {
    /** Content type (MIME type) of the file */
    contentType?: string;
    /** Custom metadata to attach to the object */
    metadata?: Record<string, string>;
    /** Cache control header */
    cacheControl?: string;
}

/**
 * Result of an upload operation.
 */
export interface UploadResult {
    /** The key/path of the uploaded object */
    key: string;
    /** ETag of the uploaded object */
    etag?: string;
    /** Version ID if versioning is enabled */
    versionId?: string;
}

/**
 * R2 Storage wrapper class.
 *
 * Provides methods for common file operations on R2 buckets.
 */
export class R2Storage {
    private bucket: R2Bucket;
    private publicUrl?: string;

    constructor(bucket: R2Bucket, publicUrl?: string) {
        this.bucket = bucket;
        this.publicUrl = publicUrl;
    }

    /**
     * Upload a file to R2.
     *
     * @param key - Object key (path) in the bucket
     * @param data - File data as ArrayBuffer, string, ReadableStream, or Blob
     * @param options - Upload options
     * @returns Upload result with key and etag
     */
    async upload(
        key: string,
        data: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob,
        options?: UploadOptions
    ): Promise<UploadResult> {
        const httpMetadata: R2HTTPMetadata = {};

        if (options?.contentType) {
            httpMetadata.contentType = options.contentType;
        }
        if (options?.cacheControl) {
            httpMetadata.cacheControl = options.cacheControl;
        }

        const result = await this.bucket.put(key, data, {
            httpMetadata,
            customMetadata: options?.metadata,
        });

        return {
            key,
            etag: result?.etag,
            versionId: result?.version,
        };
    }

    /**
     * Download a file from R2.
     *
     * @param key - Object key to download
     * @returns R2ObjectBody if found, null otherwise
     */
    async download(key: string): Promise<R2ObjectBody | null> {
        return this.bucket.get(key);
    }

    /**
     * Get object metadata without downloading the body.
     *
     * @param key - Object key
     * @returns R2Object (head) if found, null otherwise
     */
    async head(key: string): Promise<R2Object | null> {
        return this.bucket.head(key);
    }

    /**
     * Delete a file from R2.
     *
     * @param key - Object key to delete
     */
    async delete(key: string): Promise<void> {
        await this.bucket.delete(key);
    }

    /**
     * Delete multiple files from R2.
     *
     * @param keys - Array of object keys to delete
     */
    async deleteMany(keys: string[]): Promise<void> {
        await this.bucket.delete(keys);
    }

    /**
     * Check if a file exists in R2.
     *
     * @param key - Object key
     * @returns true if exists, false otherwise
     */
    async exists(key: string): Promise<boolean> {
        const obj = await this.bucket.head(key);
        return obj !== null;
    }

    /**
     * List objects in R2 with optional prefix.
     *
     * @param prefix - Prefix to filter objects
     * @param limit - Maximum number of objects to return
     * @param cursor - Cursor for pagination
     * @returns List result with objects and truncation info
     */
    async list(
        prefix?: string,
        limit?: number,
        cursor?: string
    ): Promise<R2Objects> {
        return this.bucket.list({
            prefix,
            limit,
            cursor,
        });
    }

    /**
     * Get the public URL for an object.
     * Requires publicUrl to be configured.
     *
     * @param key - Object key
     * @returns Public URL or null if publicUrl not configured
     */
    getPublicUrl(key: string): string | null {
        if (!this.publicUrl) {
            return null;
        }
        // Remove trailing slash from publicUrl if present
        const baseUrl = this.publicUrl.replace(/\/$/, "");
        return `${baseUrl}/${key}`;
    }
}

/**
 * Create an R2 storage instance from environment bindings.
 *
 * @param bucket - R2 bucket binding
 * @param publicUrl - Optional public URL for the bucket
 * @returns Configured R2Storage instance
 */
export function createStorage(bucket: R2Bucket, publicUrl?: string): R2Storage {
    return new R2Storage(bucket, publicUrl);
}

/**
 * Helper to determine content type from file extension.
 *
 * @param filename - Filename with extension
 * @returns MIME type string
 */
export function getContentType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const types: Record<string, string> = {
        // Images
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        // Documents
        pdf: "application/pdf",
        json: "application/json",
        xml: "application/xml",
        // Audio/Video
        mp3: "audio/mpeg",
        mp4: "video/mp4",
        webm: "video/webm",
        // Text
        txt: "text/plain",
        html: "text/html",
        css: "text/css",
        js: "application/javascript",
    };
    return types[ext || ""] || "application/octet-stream";
}
