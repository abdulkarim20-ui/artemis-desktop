/*
 * The one renderer page allowed to drive privileged IPC.
 *
 * A file URL is compared by its filesystem path, not by string prefix:
 *   file:///.../renderer/index.html      allowed
 *   file:///.../renderer/index.html.bak  denied
 *   https://example.com                  denied
 */
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

const RENDERER_INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_INDEX).href;
const CASE_INSENSITIVE = process.platform === 'win32';

function isRendererUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Only the local file we shipped, never file://host/share or a web page.
  if (url.protocol !== 'file:' || url.host !== '') return false;

  let candidate;
  try {
    candidate = path.normalize(fileURLToPath(url));
  } catch {
    return false;
  }

  const expected = path.normalize(RENDERER_INDEX);
  return CASE_INSENSITIVE
    ? candidate.toLowerCase() === expected.toLowerCase()
    : candidate === expected;
}

function isTrustedIpcSender(event) {
  const frame = event?.senderFrame;
  const contents = event?.sender;

  // Privileged calls come from the top frame only, not an iframe that happens
  // to load the same file.
  if (!frame || !contents || frame !== contents.mainFrame) return false;
  return isRendererUrl(frame.url);
}

module.exports = {
  RENDERER_INDEX,
  RENDERER_URL,
  isRendererUrl,
  isTrustedIpcSender,
};
