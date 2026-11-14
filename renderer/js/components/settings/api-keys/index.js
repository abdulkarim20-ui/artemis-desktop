import { el } from './dom.js';
import { PROVIDERS } from './providers.js';
import { createMessage } from './message.js';
import { createProviderCard } from './provider-card.js';

/*
 * Settings > API keys.
 * Owns the global notice and status refresh; each provider card handles one key.
 * Usage in views/settings.js:  import { createApiKeysSection } from '../components/settings/api-keys/index.js';
 */
export function createApiKeysSection() {
  const element = el('div', 'api-keys-section');
  const bridge = window.apiKeys;

  if (!bridge) {
    element.appendChild(el('p', 'settings-subtitle', 'API key storage is only available in the desktop app.'));
    return { element, destroy() {} };
  }

  const noticeNode = el('p', 'settings-key-msg is-error');
  noticeNode.hidden = true;
  const notice = createMessage(noticeNode);

  const cards = new Map();

  const render = (status) => {
    if (!status || typeof status !== 'object') throw new Error('The API key status response was invalid.');
    const encryptionAvailable = Boolean(status.encryptionAvailable);
    noticeNode.hidden = encryptionAvailable;
    notice.show(
      encryptionAvailable ? '' : 'Secure storage is not available on this system, so keys cannot be saved.',
      { error: true },
    );
    const meta = { encryptionAvailable };
    for (const provider of PROVIDERS) {
      cards.get(provider.id).render(status.providers?.[provider.id], meta);
    }
  };

  const refresh = async () => {
    try {
      render(await bridge.status());
    } catch (error) {
      noticeNode.hidden = false;
      notice.show(`Could not load API key status: ${error?.message || error}`, { error: true });
      cards.forEach((card) => card.disable());
    }
  };

  for (const provider of PROVIDERS) {
    const card = createProviderCard({ provider, bridge, onStatus: render, refresh });
    cards.set(provider.id, card);
  }

  element.append(noticeNode);
  cards.forEach((card) => element.appendChild(card.element));
  element.appendChild(el(
    'p',
    'settings-key-foot',
    'Keys are encrypted on this computer. Only a masked preview is shown. Each provider has one key; saving a new key replaces it.',
  ));

  void refresh();

  return {
    element,
    destroy() {
      cards.forEach((card) => card.destroy());
      notice.destroy();
    },
  };
}
