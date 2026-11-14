/**
 * ============================================================================
 * VISION GUARD (renderer/js/ai/vision-guard.js)
 * ============================================================================
 * Keeps "image attached" and "model can see" in agreement, without ever
 * dropping the attachment.
 *
 *   - attach time : switch to a vision model right away and say so
 *   - model change: warn if the user picks a model that cannot see the image
 *   - send time   : the same check, as a safety net; may BLOCK the send, and
 *                   when it blocks, text and attachments are left untouched
 *
 * All DOM and model-selector access is injected, so this file is unit tested.
 * ============================================================================
 */
import { isImageFile } from '../../../shared/image-formats.js';
import { imageLimits, pickVisionModel, supportsVision } from './vision-model.js';

const plural = (n, one, many) => (n === 1 ? one : many);

export function createVisionGuard({
  getModels,
  getModel,
  selectModel,
  notify,
  clearNotice = null,
  getProviderStatus = null,
}) {
  let configured = null;   // { groq: true, nvidia: false } or null when unknown
  let lastVisionId = null; // vision model most recently used or chosen in this chat

  const clear = () => {
    if (typeof clearNotice === 'function') clearNotice();
  };

  async function refreshConfigured() {
    if (typeof getProviderStatus !== 'function') return;
    try {
      const providers = (await getProviderStatus())?.providers;
      if (providers && typeof providers === 'object') {
        configured = Object.fromEntries(
          Object.entries(providers).map(([id, value]) => [id, Boolean(value?.configured)])
        );
      }
    } catch {
      configured = null;
    }
  }

  const imagesIn = (files) => Array.from(files || []).filter(isImageFile);

  /**
   * @returns {{ ok: boolean, switched: boolean, silent?: boolean, model?: object, message?: string }}
   */
  function ensure(files, phase) {
    const images = imagesIn(files);
    if (images.length === 0) return { ok: true, switched: false };

    let active = getModel();
    let switchedTo = null;

    if (!supportsVision(active)) {
      const models = getModels();
      if (!models.length) {
        return { ok: false, switched: false, silent: phase === 'attach', message: 'Models are still loading. Try again in a moment.' };
      }
      const target = pickVisionModel(models, { current: active, preferId: lastVisionId, configured });
      if (!target) {
        return {
          ok: false,
          switched: false,
          message: 'None of the configured models can read images. Add a vision model to ai-agent/config/model-registry.json.',
        };
      }
      selectModel(target.id, { persist: false });
      switchedTo = target;
      active = target;
    }

    lastVisionId = active.id;
    const { maxImages } = imageLimits(active);
    const noun = plural(images.length, 'image', 'images');
    const switchedText = switchedTo
      ? `Switched to ${switchedTo.name} so it can see your ${noun}. Your ${plural(images.length, 'attachment is', 'attachments are')} still attached.`
      : '';

    if (images.length > maxImages) {
      const limitText = `${active.name} accepts up to ${maxImages} images per message. Remove ${images.length - maxImages} to send.`;
      return { ok: false, switched: Boolean(switchedTo), model: active, message: [switchedText, limitText].filter(Boolean).join(' ') };
    }
    return { ok: true, switched: Boolean(switchedTo), model: active, message: switchedText || undefined };
  }

  return {
    refreshConfigured,
    ensure,

    /** Wire to AIInputBox option `onAttachmentsChange`. */
    onAttachmentsChanged(files) {
      const result = ensure(files, 'attach');
      if (result.message && !result.silent) {
        notify(result.message, { tone: result.ok ? 'info' : 'warn' });
      } else if (result.ok) {
        // The problem the last notice described (too many images, no vision
        // model) is gone. Do not leave a stale warning above the composer.
        clear();
      }
    },

    /** Wire to AIInputBox option `onModelChange`. */
    onModelChanged(files) {
      const model = getModel();
      if (supportsVision(model)) {
        lastVisionId = model.id;
        clear();
        return;
      }
      if (imagesIn(files).length > 0) {
        notify("This model can't read images. Artemis will switch to a vision model when you send.", { tone: 'warn' });
      }
    },

    /** Wire to AIInputBox option `beforeSend`. Return { allow:false } to cancel the send. */
    beforeSend({ attachments }) {
      const result = ensure(attachments, 'send');
      if (!result.ok) return { allow: false, message: result.message };
      if (result.switched && result.message) notify(result.message, { tone: 'info' });
      return { allow: true, switched: result.switched };
    },
  };
}
