/**
 * ============================================================================
 * SMALL-TALK DETECTOR (shared/small-talk.js)
 * ============================================================================
 * Detects messages that need no document context: greetings, thanks,
 * acknowledgements, farewells (English + common Hinglish).
 *
 * Deliberately conservative. A message is small talk only when EVERY word is
 * in the lexicon. "ok now what is his email" has content words, so it is not.
 * "yes", "no", "sure", "go on", "continue", "more" are NOT small talk: they
 * usually answer a question the assistant just asked and may need context.
 * ============================================================================
 */

const WORDS = new Set([
  // greetings
  "hi", "hii", "hiii", "hello", "hey", "heyy", "hlo", "helo", "yo", "sup", "hola", "namaste",
  "morning", "afternoon", "evening", "night", "good",
  // acknowledgements
  "ok", "okay", "okk", "okey", "k", "kk", "cool", "nice", "great", "fine", "awesome", "perfect",
  "amazing", "wow", "superb", "excellent", "alright", "right", "gotcha", "understood", "got", "it",
  "fair", "done", "noted", "hmm", "hmmm", "hm", "oh", "ah", "aha", "ooh",
  // thanks
  "thanks", "thank", "you", "thx", "ty", "tnx", "thankyou", "welcome", "so", "much", "very", "a", "lot",
  // laughter / fillers
  "lol", "haha", "hehe", "lmao",
  // farewells
  "bye", "goodbye", "cya", "later", "see",
  // Hinglish
  "accha", "acha", "achha", "theek", "thik", "hai", "haan", "han", "ha", "bhai", "bro", "dude",
  "sir", "mam", "dhanyawad", "shukriya", "mast", "badhiya", "sahi",
]);

// "so/very/a/lot/it/you/see/got/right" are only allowed inside the phrases below
// or next to another small-talk word; the all-words rule plus a length cap
// keeps "got it", "thank you so much", "see you" working without letting
// ordinary questions through.
const PHRASES = [
  /^(good )?(morning|afternoon|evening|night)$/,
  /^how (are|r) (you|u)( doing)?$/,
  /^what'?s up$/,
  /^whats up$/,
  /^(thank you|thanks|thx|ty) (so much|a lot|very much)$/,
  /^see you( later)?$/,
  /^got it$/,
];

const EMOJI_RE = /\p{Extended_Pictographic}/u;

export function normalizeSmallTalk(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSmallTalk(text) {
  const raw = String(text || "");
  if (!raw.trim() || raw.length > 60) return false;

  const norm = normalizeSmallTalk(raw);
  if (!norm) return EMOJI_RE.test(raw); // "👍", "🙏" alone

  if (PHRASES.some((re) => re.test(norm))) return true;

  const tokens = norm.split(" ");
  if (tokens.length > 4) return false;
  // Words that are only safe as part of a phrase must not stand alone as the
  // whole message ("it", "a", "so", "see", "you", "very", "much", "lot", "got", "right").
  const phraseOnly = new Set(["it", "a", "so", "see", "you", "very", "much", "lot", "got", "right", "good", "fair"]);
  const allSafe = tokens.every((t) => WORDS.has(t));
  const hasAnchor = tokens.some((t) => WORDS.has(t) && !phraseOnly.has(t));
  return allSafe && hasAnchor;
}
