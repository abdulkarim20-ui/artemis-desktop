/*
 * Provider definitions. The single source of truth for env names, key shape
 * and help URLs. The renderer never supplies any of this.
 */
const PROVIDERS = {
  groq: {
    env: 'GROQ_API_KEY',
    label: 'Groq',
    prefix: 'gsk_',
    helpUrl: 'https://console.groq.com/keys',
    valid: (key) => /^gsk_\S{20,}$/.test(key),
  },
  // Same rule NVIDIAProvider uses, so a key accepted here is never ignored later.
  nvidia: {
    env: 'NVIDIA_API_KEY',
    label: 'NVIDIA',
    prefix: 'nvapi-',
    helpUrl: 'https://build.nvidia.com/settings/api-keys',
    valid: (key) => /^nvapi-\S{20,}$/.test(key),
  },
};

const clean = (raw) => String(raw ?? '').trim().replace(/^["']|["']$/g, '').trim();

/* Preserve the key's length while exposing only a short prefix and suffix. */
const mask = (key) => {
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(key.length - 8)}${key.slice(-4)}`;
};

module.exports = { PROVIDERS, clean, mask };
