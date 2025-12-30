/**
 * Image processing for Cloudflare Workers using @cf-wasm/photon.
 *
 * This module replaces Sharp with Photon for Workers-compatible image processing.
 * Photon is Rust compiled to WebAssembly and runs natively in Workers.
 */

import { PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon";
import { thumbhash } from "./thumbhash";

/**
 * Supported image formats.
 */
export type ImageFormat = "png" | "jpeg" | "webp" | "gif";

/**
 * Result of image processing.
 */
export interface ProcessedImage {
    /** Raw RGBA pixel data of the resized image */
    pixels: Uint8Array;
    /** Original image width */
    width: number;
    /** Original image height */
    height: number;
    /** Base64-encoded thumbhash string */
    thumbhash: string;
    /** Detected image format */
    format: ImageFormat;
}

/**
 * Detect image format from magic bytes.
 *
 * @param bytes - Image data
 * @returns Detected format
 * @throws Error if format is unsupported
 */
function detectFormat(bytes: Uint8Array): ImageFormat {
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return "png";
    }
    // JPEG magic bytes: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return "jpeg";
    }
    // WebP magic bytes: RIFF....WEBP
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "webp";
    }
    // GIF magic bytes: GIF87a or GIF89a
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        return "gif";
    }
    throw new Error("Unsupported image format");
}

/**
 * Convert Uint8Array to base64 string using Web API.
 * Works in both Workers and Node.js environments.
 *
 * @param bytes - Uint8Array to convert
 * @returns Base64-encoded string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Process an image for storage.
 *
 * This function:
 * 1. Detects the image format
 * 2. Gets the original dimensions
 * 3. Resizes to max 100x100 for thumbhash generation
 * 4. Generates a thumbhash for placeholder display
 *
 * Memory management: PhotonImage instances must be freed after use.
 *
 * @param src - Image data as Uint8Array (or Buffer in Node.js)
 * @returns Processed image data
 * @throws Error if image format is unsupported or processing fails
 */
export async function processImage(src: Uint8Array | Buffer): Promise<ProcessedImage> {
    // Convert Buffer to Uint8Array if needed
    const bytes = src instanceof Uint8Array ? src : new Uint8Array(src);

    // Detect format
    const format = detectFormat(bytes);
    if (format !== "png" && format !== "jpeg") {
        throw new Error("Unsupported image format");
    }

    // Check size limit for memory safety (Workers have 128MB limit)
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    if (bytes.length > MAX_SIZE) {
        throw new Error(`Image too large: ${bytes.length} bytes (max ${MAX_SIZE})`);
    }

    // Load image from bytes
    const image = PhotonImage.new_from_byteslice(bytes);
    const width = image.get_width();
    const height = image.get_height();

    // Calculate target dimensions (max 100x100, preserving aspect ratio)
    let targetWidth = 100;
    let targetHeight = 100;
    if (width > height) {
        targetHeight = Math.round(height * targetWidth / width);
    } else if (height > width) {
        targetWidth = Math.round(width * targetHeight / height);
    }

    // Resize image for thumbhash
    const resized = resize(image, targetWidth, targetHeight, SamplingFilter.Lanczos3);
    const data = resized.get_raw_pixels(); // Uint8Array in RGBA format

    // Generate thumbhash
    const binaryThumbHash = thumbhash(
        resized.get_width(),
        resized.get_height(),
        data
    );
    const thumbhashStr = uint8ArrayToBase64(binaryThumbHash);

    // Free WASM memory - critical to prevent leaks
    image.free();
    resized.free();

    return {
        pixels: data,
        width,
        height,
        thumbhash: thumbhashStr,
        format,
    };
}
