/**
 * Pure helpers about which models can read images. No DOM, no fetch.
 */
import { IMAGE_LIMITS } from '../../../shared/image-formats.js';

export const supportsVision = (model) => Boolean(model?.capabilities?.vision);

export function imageLimits(model) {
  const read = (key, fallback) => {
    const value = Number(model?.imageLimits?.[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    maxImages: Math.floor(read('maxImages', IMAGE_LIMITS.MAX_IMAGES_PER_MESSAGE)),
    maxImageBytes: read('maxImageBytes', IMAGE_LIMITS.MAX_ENCODED_BYTES),
    maxTotalImageBytes: read('maxTotalImageBytes', IMAGE_LIMITS.MAX_TOTAL_ENCODED_BYTES),
  };
}

/**
 * Choose which vision model to switch to.
 *
 * Score (highest wins, registry order breaks ties):
 *   +4  the vision model used most recently in this chat
 *   +2  its provider has a saved API key (only when that is known)
 *   +1  same provider as the current model (usually the same key, same speed)
 *
 * `configured` is a PREFERENCE, not a filter: keys in .env do not appear in
 * window.apiKeys.status(), so "not configured" must never remove a model.
 *
 * @param {Array<object>} models
 * @param {{ current?: object|null, preferId?: string|null, configured?: Record<string, boolean>|null }} [options]
 * @returns {object|null}
 */
export function pickVisionModel(models, { current = null, preferId = null, configured = null } = {}) {
  const scored = Array.from(models || [])
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => supportsVision(model))
    .map(({ model, index }) => {
      let score = 0;
      if (preferId && model.id === preferId) score += 4;
      if (configured && configured[model.provider] === true) score += 2;
      if (current && model.provider === current.provider) score += 1;
      return { model, index, score };
    });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.model || null;
}
