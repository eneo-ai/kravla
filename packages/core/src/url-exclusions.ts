// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Crawl-link exclusions for same-site navigation that is rarely useful to
 * index. Patterns match `pathname + search` and intentionally use a tiny
 * glob dialect: `*` for one path segment/search fragment, `**` for anything.
 */
export const COMMON_CRAWL_EXCLUDE_GLOBS = [
  "**triggerlogin=1**",
  "/loggain",
  "/loggain/**",
  "/loggain?**",
  "/login",
  "/login/**",
  "/login?**",
  "/logout",
  "/logout/**",
  "/logout?**",
  "/signin",
  "/signin/**",
  "/signin?**",
  "/sign-in",
  "/sign-in/**",
  "/sign-in?**",
  "/signout",
  "/signout/**",
  "/signout?**",
  "/sign-out",
  "/sign-out/**",
  "/sign-out?**",
] as const;

const COMMON_CRAWL_EXCLUDE_REGEXES = COMMON_CRAWL_EXCLUDE_GLOBS.map(globToRegExp);

export function normalizeExcludeUrlPatterns(
  patterns: readonly string[] | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of patterns ?? []) {
    const pattern = raw.trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

export function isExcludedCrawlUrl(
  url: string,
  extraPatterns: readonly string[] | null | undefined = [],
): boolean {
  let pathAndSearch: string;
  try {
    const parsed = new URL(url);
    pathAndSearch = parsed.pathname + parsed.search;
  } catch {
    return false;
  }

  if (COMMON_CRAWL_EXCLUDE_REGEXES.some((pattern) => pattern.test(pathAndSearch))) return true;
  return normalizeExcludeUrlPatterns(extraPatterns).some((pattern) =>
    globToRegExp(pattern).test(pathAndSearch),
  );
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (char === "*") {
      if (glob.charAt(i + 1) === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
