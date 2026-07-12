// A small, dependency-free HTML → Markdown converter, scoped to the kind of
// markup CivitAI model/version descriptions use (paragraphs, line breaks,
// headings, bold/italic, links, lists, code, blockquotes). It is deliberately
// forgiving: anything it doesn't recognise is stripped rather than escaped, so
// the output is always readable plain-ish Markdown for an agent to consume — it
// is NOT a faithful round-trippable transform.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? m;
  });
}

/**
 * Convert a subset of HTML to Markdown. Returns "" for empty/whitespace input.
 */
export function htmlToMarkdown(html: string | undefined | null): string {
  if (!html) return "";
  let s = html;

  // Drop elements whose content is never useful as text.
  s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "");
  // Comments.
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // Inline formatting.
  s = s.replace(/<\s*(strong|b)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, "**$2**");
  s = s.replace(/<\s*(em|i)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, "_$2_");
  s = s.replace(/<\s*code\b[^>]*>([\s\S]*?)<\/\s*code\s*>/gi, "`$1`");
  s = s.replace(
    /<\s*a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/\s*a\s*>/gi,
    (_m, href: string, text: string) => {
      const t = text.trim() || href;
      return href ? `[${t}](${href})` : t;
    },
  );

  // Headings → ATX. Level from the tag number.
  s = s.replace(
    /<\s*h([1-6])\b[^>]*>([\s\S]*?)<\/\s*h\1\s*>/gi,
    (_m, lvl: string, text: string) =>
      `\n\n${"#".repeat(Number(lvl))} ${text.trim()}\n\n`,
  );

  // List items → "- " lines (ordered lists also become dashes; good enough).
  s = s.replace(/<\s*li\b[^>]*>([\s\S]*?)<\/\s*li\s*>/gi, (_m, text: string) => {
    return `\n- ${text.trim()}`;
  });
  s = s.replace(/<\/?\s*(ul|ol)\b[^>]*>/gi, "\n");

  // Blockquotes.
  s = s.replace(
    /<\s*blockquote\b[^>]*>([\s\S]*?)<\/\s*blockquote\s*>/gi,
    (_m, text: string) =>
      "\n" +
      text
        .trim()
        .split(/\n/)
        .map((l) => `> ${l.trim()}`)
        .join("\n") +
      "\n",
  );

  // Block separators.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n\n");
  s = s.replace(/<\s*p\b[^>]*>/gi, "");
  s = s.replace(/<\/?\s*div\b[^>]*>/gi, "\n");
  s = s.replace(/<\s*hr\s*\/?\s*>/gi, "\n\n---\n\n");

  // Strip any remaining tags.
  s = s.replace(/<[^>]+>/g, "");

  s = decodeEntities(s);

  // Normalise whitespace: trim each line, collapse 3+ blank lines to one.
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s;
}
