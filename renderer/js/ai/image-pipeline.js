/**
 * ============================================================================
 * IMAGE PIPELINE (renderer/js/ai/image-pipeline.js)
 * ============================================================================
 * Turns attached image Files into PreparedImage objects the agent can send to a
 * vision model: decoded, resized, re-encoded, hashed.
 *
 * Deliberately knows nothing about chat, models or retrieval. A future image
 * knowledge base reuses prepareImages() and the PreparedImage `id` (content hash).
 * ============================================================================
 */
import { IMAGE_LIMITS, isImageFile } from '../../../shared/image-formats.js';

export { isImageFile };

export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

const nameOf = (file) => file?.webkitRelativePath || file?.name || 'image';

/** Split attachments into images (vision path) and everything else (file/RAG path). */
export function partitionAttachments(files) {
  const images = [];
  const others = [];
  for (const file of Array.from(files || [])) {
    (isImageFile(file) ? images : others).push(file);
  }
  return { images, others };
}

const escapeAttr = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Tiny text note stored in the chat text. Bytes travel separately in `images`. */
export function buildImageNote(images) {
  if (!images?.length) return '';
  const rows = images
    .map((image) => `  <image name="${escapeAttr(image.name)}" id="${escapeAttr(image.id)}" />`)
    .join('\n');
  return `<attached_images count="${images.length}">\n${rows}\n</attached_images>`;
}

/**
 * Keep image bytes only for the newest `keep` images in the history. Older
 * messages keep their text note, so the model still knows an image existed.
 */
export function compactHistoryImages(history, { keep = IMAGE_LIMITS.MAX_IMAGES_PER_MESSAGE } = {}) {
  let remaining = keep;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (!Array.isArray(message.images) || message.images.length === 0) continue;
    if (message.images.length <= remaining) {
      remaining -= message.images.length;
      continue;
    }
    const kept = remaining > 0 ? message.images.slice(message.images.length - remaining) : [];
    remaining = 0;
    if (kept.length) message.images = kept;
    else delete message.images;
  }
  return history;
}

/* ---------- encoding (browser only; injected in tests) ---------- */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('could not read the image'));
    reader.readAsDataURL(blob);
  });
}

async function contentId(blob) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return `img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

async function draw(bitmap, width, height, { type, quality, flatten }) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (flatten) {
    // JPEG has no transparency: paint white first so transparent PNGs do not turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
}

async function finish(blob, width, height) {
  return {
    id: await contentId(blob),
    mime: blob.type,
    dataUrl: await blobToDataUrl(blob),
    width,
    height,
    bytes: blob.size,
  };
}

/**
 * Decode, shrink and re-encode one image so it fits `maxBytes`.
 * PNG sources stay PNG when they fit (sharp text in screenshots); otherwise JPEG
 * at falling quality and falling size until it fits.
 */
export async function encodeImageFile(file, options = {}) {
  const maxBytes = options.maxBytes ?? IMAGE_LIMITS.MAX_ENCODED_BYTES;
  const first = options.maxDimension ?? IMAGE_LIMITS.MAX_DIMENSION;
  const dimensions = [first, ...IMAGE_LIMITS.FALLBACK_DIMENSIONS.filter((d) => d < first)];
  const preferPng = String(file.type).toLowerCase() === 'image/png';

  let bitmap;
  try {
    bitmap = await createImageBitmap(file); // applies EXIF rotation
  } catch {
    throw new ImageError('undecodable', 'the image could not be opened (damaged or unsupported format)');
  }

  try {
    for (const limit of dimensions) {
      const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      if (preferPng) {
        const png = await draw(bitmap, width, height, { type: 'image/png', flatten: false });
        if (png.size <= maxBytes) return finish(png, width, height);
      }
      for (const quality of IMAGE_LIMITS.JPEG_QUALITIES) {
        const jpeg = await draw(bitmap, width, height, { type: 'image/jpeg', quality, flatten: true });
        if (jpeg.size <= maxBytes) return finish(jpeg, width, height);
      }
    }
  } finally {
    bitmap.close?.();
  }
  throw new ImageError('tooLarge', 'the image is too large to send, even after shrinking it');
}

/**
 * Prepare up to `maxImages` images. Never throws for a bad image: it returns a
 * human-readable warning instead, so one broken file cannot stop a message.
 *
 * @param {File[]} files
 * @param {{ encoder?: Function, maxImages?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ images: object[], warnings: string[] }>}
 */
export async function prepareImages(files, {
  encoder = encodeImageFile,
  maxImages = IMAGE_LIMITS.MAX_IMAGES_PER_MESSAGE,
  maxBytes = IMAGE_LIMITS.MAX_ENCODED_BYTES,
} = {}) {
  const list = Array.from(files || []).filter(isImageFile);
  const images = [];
  const warnings = [];

  for (const file of list.slice(maxImages)) {
    warnings.push(`${nameOf(file)}: not sent, a message can include at most ${maxImages} images`);
  }

  for (const file of list.slice(0, maxImages)) {
    const name = nameOf(file);
    if (!file.size) {
      warnings.push(`${name}: skipped, the file is empty`);
      continue;
    }
    if (file.size > IMAGE_LIMITS.MAX_SOURCE_BYTES) {
      warnings.push(`${name}: skipped, the file is larger than ${IMAGE_LIMITS.MAX_SOURCE_BYTES / 1024 / 1024} MB`);
      continue;
    }
    try {
      const encoded = await encoder(file, { maxBytes });
      images.push({
        id: encoded.id,
        name,
        mime: encoded.mime,
        dataUrl: encoded.dataUrl,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.bytes,
        source: 'attached',
      });
    } catch (error) {
      warnings.push(`${name}: skipped, ${error?.message || 'the image could not be read'}`);
    }
  }
  return { images, warnings };
}
