"use strict";

// Pure quality, ranking, and evidence-formatting helpers for deep_research.
// Keeping these functions side-effect free makes the retrieval policy testable
// without making network requests.

const CHALLENGE_PAGE_RE =
  /just a moment|enable javascript and cookies|verifying you are human|attention required|checking your browser|cf-chl-|performing security verification|are you a human|captcha required/i;

const READER_ERROR_RE =
  /^(?:error|failed|failure|access denied|forbidden|unavailable|service unavailable)\b/i;
const PAYWALL_PAGE_RE =
  /subscribe to continue|sign in to continue reading|register to read|you have reached your (?:free )?article limit|subscriber[- ]only|become a subscriber to read/i;

// Grokipedia is explicitly prohibited as a research source. Match the host
// label rather than one exact URL so subdomains and future Grokipedia mirrors
// cannot enter the evidence pipeline accidentally.
function isForbiddenResearchUrl(value) {
  try {
    const hostname = new URL(String(value || "")).hostname.toLowerCase();
    return hostname.split(".").some((label) => label.includes("grokipedia"));
  } catch {
    return false;
  }
}

function forbiddenResearchUrlError(value) {
  return isForbiddenResearchUrl(value)
    ? "Grokipedia is permanently blocked by Dive research policy"
    : "";
}

const RESEARCH_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "being",
  "by",
  "can",
  "cómo",
  "como",
  "con",
  "could",
  "de",
  "del",
  "describe",
  "do",
  "does",
  "el",
  "en",
  "for",
  "from",
  "fué",
  "fue",
  "had",
  "has",
  "have",
  "he",
  "her",
  "history",
  "how",
  "in",
  "is",
  "it",
  "la",
  "las",
  "lo",
  "los",
  "más",
  "mas",
  "may",
  "me",
  "of",
  "on",
  "or",
  "para",
  "que",
  "qué",
  "se",
  "should",
  "sobre",
  "su",
  "the",
  "their",
  "there",
  "these",
  "this",
  "to",
  "un",
  "una",
  "with",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "would",
  "y",
  "biography",
  "biographical",
  "biografía",
  "biografico",
  "biográfico",
  "information",
  "información",
  "overview",
  "research",
  "researching",
  "study",
  "studies",
  "latest",
  "today",
  "current",
  "recent",
  "update",
  "updates",
  "official",
  "primary",
  "sources",
  "records",
  "independent",
  "reporting",
  "verification",
  "authoritative",
  "analysis",
  "criticism",
  "context",
]);

const TRACKING_PARAMS_RE =
  /^(?:utm_[^=]+|fbclid|gclid|ref|ref_src|source|mc_cid|mc_eid|trk|campaign)$/i;

function normalizeResearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function researchTokens(value, { includeStopwords = false } = {}) {
  const normalized = normalizeResearchText(value);
  if (!normalized) return [];
  return [
    ...new Set(
      normalized
        .split(" ")
        .filter((token) => token.length > 1)
        .filter((token) => includeStopwords || !RESEARCH_STOPWORDS.has(token)),
    ),
  ];
}

function canonicalResearchUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS_RE.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return String(value || "").trim();
  }
}

function researchDomain(value) {
  try {
    return new URL(String(value || "")).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isWikipediaUrl(value) {
  return /(?:^|\.)wikipedia\.org$/i.test(researchDomain(value));
}

function isBritannicaUrl(value) {
  return /(?:^|\.)britannica\.com$/i.test(researchDomain(value));
}

function isLarousseUrl(value) {
  return /(?:^|\.)larousse\.fr$/i.test(researchDomain(value));
}

function isScholarpediaUrl(value) {
  return /(?:^|\.)scholarpedia\.org$/i.test(researchDomain(value));
}

function isSnlUrl(value) {
  return researchDomain(value) === "snl.no";
}

function isArchivePhUrl(value) {
  return /(?:^|\.)archive\.ph$/i.test(researchDomain(value));
}

function validateReaderText(value, minimumChars = 200) {
  const text = String(value || "").trim();
  if (!text) return { ok: false, error: "empty reader response" };
  if (text.length < minimumChars) {
    return {
      ok: false,
      error: `reader response was too short (${text.length} characters)`,
    };
  }

  const head = text.slice(0, 1800);
  if (/^\s*(?:<!doctype\s+html|<html\b|<head\b)/i.test(text)) {
    return {
      ok: false,
      error: "reader returned raw HTML instead of article text",
    };
  }
  if (
    /<title>\s*(?:just a moment|attention required|access denied|verify)/i.test(
      head,
    )
  ) {
    return { ok: false, error: "reader returned a bot-protection page" };
  }
  if (CHALLENGE_PAGE_RE.test(head)) {
    return {
      ok: false,
      error: "reader returned a bot-protection or CAPTCHA page",
    };
  }
  if (PAYWALL_PAGE_RE.test(head)) {
    return { ok: false, error: "reader returned a paywall or login wall" };
  }
  if (READER_ERROR_RE.test(text) || /^\s*(?:\{|\[|")/.test(text)) {
    return { ok: false, error: "reader returned an error payload" };
  }
  return { ok: true, text };
}

function countTokenMatches(value, tokens) {
  const haystack = new Set(researchTokens(value, { includeStopwords: true }));
  return tokens.filter((token) => haystack.has(token));
}

// A host counts as `suffix` only if it IS that domain or sits under it.
// Substring matching cannot be used here: "nature.com" appears in
// "nature.com.phish.io", and an attacker-registered look-alike would inherit
// the authority of the publication it imitates.
function domainIsOrUnder(domain, suffix) {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

function domainUnderAny(domain, suffixes) {
  return suffixes.some((suffix) => domainIsOrUnder(domain, suffix));
}

// Public-sector and academic namespaces, matched at the end of the host so a
// look-alike like "cam.ac.attacker.net" cannot claim them.
const GOV_DOMAIN_RE = /(?:^|\.)gov(?:\.[a-z]{2})?$/i;
const EDU_DOMAIN_RE = /(?:^|\.)edu(?:\.[a-z]{2})?$/i;
const AC_DOMAIN_RE = /(?:^|\.)ac\.[a-z]{2}$/i;
// .museum and .university are real top-level domains. Matching them as bare
// substrings previously handed "cheap-university-essays.biz" the authority of
// a national institution.
const INSTITUTION_TLD_RE = /(?:^|\.)(?:museum|university)$/i;

const INDEX_DOMAINS = [
  "doi.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "arxiv.org",
  "openalex.org",
  "semanticscholar.org",
];

const PUBLISHER_DOMAINS = [
  "nature.com",
  "science.org",
  "sciencedirect.com",
  "springer.com",
  "wiley.com",
  "jstor.org",
  "plos.org",
  "frontiersin.org",
  "oup.com",
  "cambridge.org",
  "tandfonline.com",
];

const ARCHIVE_DOMAINS = [
  "archive.org",
  "loc.gov",
  "nationalarchives.gov.uk",
  "britishmuseum.org",
];

const ENCYCLOPEDIA_DOMAINS = ["britannica.com", "wikipedia.org"];

function authorityScore(candidate) {
  const url = String(candidate?.url || "");
  const domain = researchDomain(url);
  const type = String(candidate?.sourceType || "").toLowerCase();
  if (type === "wikipedia") return 30;
  if (type === "larousse") return 29;
  if (type === "scholarpedia") return 31;
  if (type === "snl") return 29;
  if (type === "britannica") return 28;
  if (type === "official") return 25;
  if (type === "academic") return 24;
  if (!domain) return 0;
  if (GOV_DOMAIN_RE.test(domain)) return 24;
  if (domainUnderAny(domain, INDEX_DOMAINS)) return 22;
  if (EDU_DOMAIN_RE.test(domain) || AC_DOMAIN_RE.test(domain)) return 20;
  if (domainUnderAny(domain, ENCYCLOPEDIA_DOMAINS)) return 20;
  if (domainUnderAny(domain, PUBLISHER_DOMAINS)) return 19;
  if (
    domainUnderAny(domain, ARCHIVE_DOMAINS) ||
    INSTITUTION_TLD_RE.test(domain)
  )
    return 18;
  return 0;
}

function scoreResearchCandidate(
  candidate,
  query,
  { primaryQuery = query } = {},
) {
  const primaryTokens = researchTokens(primaryQuery);
  const queryTokens = researchTokens(query);
  const title = String(candidate?.title || "");
  const snippet = String(candidate?.snippet || candidate?.abstract || "");
  const url = String(candidate?.url || "");
  const titleMatches = countTokenMatches(title, primaryTokens);
  const contextMatches = countTokenMatches(`${snippet} ${url}`, queryTokens);
  const allMatches = [...new Set([...titleMatches, ...contextMatches])];
  const normalizedTitle = normalizeResearchText(title);
  const normalizedPrimary = normalizeResearchText(primaryQuery);
  let score = Number(candidate?.priority || 0) + authorityScore(candidate);

  score += titleMatches.length * 9;
  score += contextMatches.length * 3;
  if (normalizedPrimary && normalizedTitle.includes(normalizedPrimary))
    score += 25;
  if (
    candidate?.sourceType === "wikipedia" ||
    candidate?.sourceType === "britannica" ||
    candidate?.sourceType === "larousse" ||
    candidate?.sourceType === "scholarpedia" ||
    candidate?.sourceType === "snl"
  )
    score += 8;
  if (candidate?.abstract) score += 2;
  if (candidate?.snippet) score += 1;

  return {
    ...candidate,
    score,
    matchedTokens: allMatches,
    titleMatches,
    contextMatches,
    domain: researchDomain(url),
  };
}

function rankResearchCandidates(candidates, query, options = {}) {
  const primaryTokens = researchTokens(options.primaryQuery || query);
  return candidates
    .map((candidate) => scoreResearchCandidate(candidate, query, options))
    .filter((candidate) => {
      if (
        candidate.sourceType === "wikipedia" ||
        candidate.sourceType === "britannica" ||
        candidate.sourceType === "larousse" ||
        candidate.sourceType === "scholarpedia" ||
        candidate.sourceType === "snl"
      )
        return true;
      if (!primaryTokens.length) return true;
      return candidate.matchedTokens.length > 0;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.titleMatches.length !== a.titleMatches.length) {
        return b.titleMatches.length - a.titleMatches.length;
      }
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
}

function selectDiverseResearchCandidates(candidates, target) {
  const limit = Math.max(1, Math.floor(Number(target) || 1));
  const picked = [];
  const domains = new Set();

  // Give authoritative anchor sources a guaranteed place, but never let an
  // anchor crowd out every independent source.
  for (const candidate of candidates) {
    if (!candidate.anchor || picked.length >= limit) continue;
    const domain = candidate.domain || researchDomain(candidate.url);
    if (!domain || domains.has(domain)) continue;
    picked.push(candidate);
    domains.add(domain);
  }

  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    const domain = candidate.domain || researchDomain(candidate.url);
    if (!domain || domains.has(domain)) continue;
    picked.push(candidate);
    domains.add(domain);
  }

  // If there are fewer domains than requested, use the best remaining records
  // rather than inventing a minimum source count with irrelevant pages.
  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    if (!picked.includes(candidate)) picked.push(candidate);
  }
  return picked;
}

function evidenceFingerprint(value) {
  return normalizeResearchText(value)
    .split(" ")
    .filter(Boolean)
    .slice(0, 180)
    .join(" ");
}

function compactEvidenceText(value, maxChars = 5200) {
  const lines = String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". ") + 1);
  return `${cut.slice(0, boundary > 250 ? boundary : maxChars)}\n[Evidence excerpt truncated]`;
}

function sourceReliabilityLabel(candidate) {
  if (candidate?.retrieval?.service === "wayback")
    return "archived copy via the Wayback Machine; verify capture date";
  if (candidate?.retrieval?.service === "archive.ph")
    return "archived copy via archive.ph; verify capture date and corroborate";
  const score = authorityScore(candidate);
  if (candidate?.sourceType === "wikipedia")
    return "authoritative orientation source";
  if (candidate?.sourceType === "britannica")
    return "editorial reference source";
  if (candidate?.sourceType === "larousse")
    return "French editorial encyclopedia source";
  if (candidate?.sourceType === "scholarpedia")
    return "peer-reviewed expert encyclopedia source";
  if (candidate?.sourceType === "snl")
    return "Norwegian editorial encyclopedia source";
  if (candidate?.sourceType === "academic" || score >= 22)
    return "scholarly or institutional source";
  if (score >= 15) return "specialist or archival source";
  return "general web source; corroboration required";
}

module.exports = {
  CHALLENGE_PAGE_RE,
  RESEARCH_STOPWORDS,
  normalizeResearchText,
  researchTokens,
  canonicalResearchUrl,
  researchDomain,
  isWikipediaUrl,
  isBritannicaUrl,
  isLarousseUrl,
  isScholarpediaUrl,
  isSnlUrl,
  isArchivePhUrl,
  isForbiddenResearchUrl,
  forbiddenResearchUrlError,
  validateReaderText,
  countTokenMatches,
  authorityScore,
  scoreResearchCandidate,
  rankResearchCandidates,
  selectDiverseResearchCandidates,
  evidenceFingerprint,
  compactEvidenceText,
  sourceReliabilityLabel,
};
