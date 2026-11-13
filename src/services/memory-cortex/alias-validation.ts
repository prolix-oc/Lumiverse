const COMMON_ALIAS_REJECTS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "i", "me", "my", "mine", "you", "your", "yours", "he", "him", "his", "she", "her", "hers",
  "they", "them", "their", "theirs", "we", "us", "our", "ours", "it", "its",
  "someone", "everyone", "anyone", "nobody", "nothing", "something", "everything", "anything",
  "people", "person", "friend", "friends", "family", "crew", "team", "group", "stranger", "strangers",
  "name", "alias", "nickname", "moniker", "title", "role", "character", "user", "player", "assistant",
  "good", "bad", "best", "better", "old", "new", "young", "little", "big", "great", "small",
  "personal", "private", "public", "common", "strange", "barely", "having", "every", "always", "never",
  "here", "there", "where", "when", "while", "before", "after", "because", "through", "under", "over",
  "among", "around", "inside", "outside", "within", "without", "toward", "between", "during",
  "cost", "voice", "eyes", "hands", "face", "hair", "head", "heart", "mind", "body", "words",
]);

const ALLOWED_PARTICLES = new Set([
  "the", "of", "de", "del", "der", "la", "le", "du", "van", "von", "da", "di", "el", "al",
]);

const PHRASE_START_REJECTS = new Set([
  "a", "an", "and", "as", "at", "because", "before", "between", "but", "by", "during", "for", "from",
  "if", "in", "inside", "into", "like", "of", "on", "or", "since", "so", "than", "that", "then", "though",
  "through", "to", "toward", "under", "unless", "until", "when", "where", "while", "with", "without",
]);

function normalizeAliasKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/[\u2018\u2019\u02BC'']/g, "'")
    .replace(/[^a-z0-9\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNameLikeWord(word: string): boolean {
  const cleaned = word.replace(/^["'\u201C\u201D\u2018\u2019()[\]{}]+|["'\u201C\u201D\u2018\u2019()[\]{}.,!?;:]+$/g, "");
  if (!cleaned) return false;
  if (ALLOWED_PARTICLES.has(cleaned.toLowerCase())) return true;
  return /^[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?$/.test(cleaned)
    || /^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(cleaned)
    || /^[A-Z]{2,4}$/.test(cleaned);
}

export function isPlausibleAlias(alias: string, canonicalName?: string): boolean {
  const trimmed = alias.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 50) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;
  if (/[\r\n\[\]{}|<>#@\\~`]/.test(trimmed)) return false;
  if (/^[-\u2014\u2013\s_.=]+$/.test(trimmed)) return false;
  if (/[.!?;:]$/.test(trimmed)) return false;
  if (/\b(?:is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|would|should|will|shall)\b/i.test(trimmed)) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;

  const first = words[0].toLowerCase().replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019.,!?;:]+$/g, "");
  if (PHRASE_START_REJECTS.has(first)) return false;

  const key = normalizeAliasKey(trimmed);
  if (!key || COMMON_ALIAS_REJECTS.has(key)) return false;
  if (canonicalName && key === normalizeAliasKey(canonicalName)) return false;

  if (words.length === 1) {
    if (COMMON_ALIAS_REJECTS.has(first)) return false;
    if (/^[A-Z]{5,}$/.test(trimmed)) return false;
    return isNameLikeWord(trimmed);
  }

  const significantWords = words.filter((word) => !ALLOWED_PARTICLES.has(word.toLowerCase()));
  if (significantWords.length === 0) return false;
  if (!significantWords.some((word) => /^[A-Z]/.test(word))) return false;
  if (significantWords.some((word) => COMMON_ALIAS_REJECTS.has(word.toLowerCase()))) return false;
  return words.every(isNameLikeWord);
}

export function sanitizeAlias(alias: string): string | null {
  const trimmed = alias.trim().replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019.,!?;:]+$/g, "").replace(/\s+/g, " ");
  return trimmed ? trimmed : null;
}
