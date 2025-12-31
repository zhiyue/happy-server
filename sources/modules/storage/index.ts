/**
 * Storage module exports.
 *
 * Provides file storage functionality using Cloudflare R2.
 */

export { R2Storage, createStorage, getContentType } from "./r2";
export type { UploadOptions, UploadResult } from "./r2";
