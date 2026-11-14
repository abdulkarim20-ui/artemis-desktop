/**
 * Decides which retrieved sources an answer actually USED when a model did
 * not emit structured citation markers.
 */
const STOP = new Set((
  'a an the and or but if then than so as at by for from in into of on to with without about above after again ' +
  'also because before being below between both can could did do does doing down during each few further had has ' +
  'have having he her here hers him his how i is it its itself just me more most my no nor not now off once only ' +
  'other our out over own same she should some such that their them there these they this those through under ' +
  'until up very was we were what when where which while who whom why will would you your yours are be been'
).split(' '));

const REFUSAL_RE = new RegExp([
  "(?:can(?:'|’)?t|cannot|could(?:n(?:'|’)?t| not)|unable to|do(?:es)?(?:n(?:'|’)?t| not)|did(?:n(?:'|’)?t| not)) (?:find|see|locate)",
  "(?:do(?:es)?(?:n(?:'|’)?t| not)|did(?:n(?:'|’)?t| not)) (?:mention|contain|cover|include|discuss|have|address)",
  "(?:is|are|was|were) not (?:mentioned|covered|included|present|found|available)",
  "no (?:mention|information|details?|reference|results?) (?:of|about|on|for|in)",
  "nothing (?:relevant )?(?:was )?(?:found|in)",
  "not (?:in|from|part of|present in) (?:the |your |any )?(?:provided |attached |uploaded )?(?:files?|documents?|knowledge)",
  "general knowledge[^.\\n]{0,40}not (?:from|in)",
  "(?:outside|beyond) (?:the |your )?(?:provided |attached )?(?:files?|documents?)",
].join('|'), 'i');

const REFUSAL_WINDOW = 400;
const MIN_SHARED_PHRASES = 2;
const MIN_SHARED_TERMS = 7;
const MIN_COVERAGE = 0.2;

const words = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const isContent = (word) => word.length >= 4 && !STOP.has(word);
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const fileName = (path) => String(path || '').split(/[\\/]/).pop() || '';
const baseName = (path) => fileName(path).replace(/\.[^.]+$/, '');

function stripFileNames(answer, sources) {
  let text = String(answer || '');
  const names = new Set();
  for (const source of sources) {
    for (const name of [fileName(source.path), baseName(source.path)]) {
      if (name && name.length >= 3) names.add(name);
    }
  }
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`${escapeRe(name)}(?:\\s+L\\d+(?:-\\d+)?)?`, 'gi'), ' ');
  }
  return text;
}

function trigrams(list) {
  const set = new Set();
  for (let i = 0; i + 2 < list.length; i += 1) {
    const gram = [list[i], list[i + 1], list[i + 2]];
    if (gram.filter(isContent).length >= 2) set.add(gram.join(' '));
  }
  return set;
}

/**
 * @param {string} answer
 * @param {Array<{ path?: string, body?: string, excerpt?: string }>} sources
 * @returns {Array<object>} only the sources the answer likely used
 */
export function selectUsedSources(answer, sources) {
  const list = Array.isArray(sources) ? sources : [];
  const full = String(answer || '');
  if (!list.length || !full.trim()) return [];

  if (REFUSAL_RE.test(full.slice(0, REFUSAL_WINDOW))) return [];

  const answerWords = words(stripFileNames(full, list));
  const answerGrams = trigrams(answerWords);
  const answerTerms = new Set(answerWords.filter(isContent));
  if (!answerTerms.size) return [];

  return list.filter((source) => {
    const passage = words(source.body || source.excerpt);
    if (!passage.length) return false;

    let sharedPhrases = 0;
    for (const gram of trigrams(passage)) if (answerGrams.has(gram)) sharedPhrases += 1;
    if (sharedPhrases >= MIN_SHARED_PHRASES) return true;

    const terms = new Set(passage.filter(isContent));
    let shared = 0;
    for (const term of terms) if (answerTerms.has(term)) shared += 1;

    return shared >= MIN_SHARED_TERMS && shared / Math.max(terms.size, 1) >= MIN_COVERAGE;
  });
}
