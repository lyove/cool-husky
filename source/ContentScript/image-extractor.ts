import { detectMediaFromUrl } from '../utils/detect';

/**
 * DOM image extractor, modeled after the Media-downloader extension.
 *
 * The network-request based sniffer (Background webRequest) can only see images
 * whose request is actually in flight (not cache hits / already-loaded / lazy-loaded
 * images, srcset candidates the browser did not pick, CSS backgrounds, etc.).
 * This extractor proactively walks the DOM and CSSOM to find those images:
 *   - <img src|currentSrc|srcset|data-src(and friends)>
 *   - <a href> pointing to an image
 *   - <picture> > <source srcset>
 *   - <object data> / <embed src>
 *   - computed styles (background-image / mask-image / ...) on elements with inline styles
 *   - ::before / ::after pseudo-element computed styles
 *   - stylesheet cssRules (background-image / mask-image)
 */

// Formats aligned with settings.ts IMAGE_FORMATS (the UI already supports them)
const IMAGE_FORMATS = new Set([
  'gif',
  'jpg',
  'png',
  'webp',
  'svg',
  'avif',
  'bmp',
  'ico',
  'heic',
  'heif',
  'apng',
  'tiff',
]);

// Style properties that may embed url(...) image references
const IMAGE_STYLE_PROPERTIES = [
  'backgroundImage',
  'maskImage',
  'borderImageSource',
  'listStyleImage',
  'cursor',
  'clipPath',
  'content',
  'filter',
  'shapeOutside',
] as const;

// Lazy-loading attributes commonly used by image lazy-load libraries
const LAZY_SRC_ATTRS = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-lazy',
  'data-url',
  'data-original-src',
  'data-hi-res-src',
] as const;

const CANDIDATE_SELECTOR =
  'img, a[href], picture, object[data], embed[src], [style]';

// Cap the number of [style] elements whose computed styles we read per scan,
// avoiding getComputedStyle() cost blow-ups on huge pages.
const MAX_STYLE_ELEMENTS_PER_SCAN = 800;

export interface DomImageCandidate {
  url: string;
  format: string;
}

function normalizeUrl(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:')) return null;
  try {
    return new URL(trimmed, location.href).href;
  } catch {
    return null;
  }
}

// Extract every url(...) token from a style value (e.g. "url(a.png), url(b.png)")
function extractUrlsFromStyleValue(value: string | undefined): string[] {
  if (!value) return [];
  const urls: string[] = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const u = m[2]?.trim();
    if (u && !u.startsWith('data:')) urls.push(u);
  }
  return urls;
}

// Parse srcset: "a.png 1x, b.png 2x" / "a.png 480w, b.png 800w"
function parseSrcset(srcset: string | null | undefined): string[] {
  if (!srcset) return [];
  return srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(
      (u): u is string => typeof u === 'string' && !u.startsWith('data:')
    );
}

function collect(
  rawUrls: string[],
  seen: Set<string>,
  out: DomImageCandidate[]
): void {
  for (const raw of rawUrls) {
    const abs = normalizeUrl(raw);
    if (!abs || seen.has(abs)) continue;
    const format = detectMediaFromUrl(abs);
    if (!format || !IMAGE_FORMATS.has(format)) continue;
    seen.add(abs);
    out.push({ url: abs, format });
  }
}

function extractFromElement(
  el: Element,
  seen: Set<string>,
  out: DomImageCandidate[]
): void {
  const tag = el.tagName.toLowerCase();

  if (tag === 'img') {
    const img = el as HTMLImageElement;
    // currentSrc reflects the URL the browser actually loaded (highest picked srcset candidate)
    if (img.currentSrc) collect([img.currentSrc, img.src], seen, out);
    else collect([img.src], seen, out);
    collect(parseSrcset(img.getAttribute('srcset')), seen, out);
    collect(
      LAZY_SRC_ATTRS.map((attr) => img.getAttribute(attr)).filter(
        (v): v is string => Boolean(v)
      ),
      seen,
      out
    );
    const lazySrcset = img.getAttribute('data-srcset');
    if (lazySrcset) collect(parseSrcset(lazySrcset), seen, out);
  } else if (tag === 'a') {
    collect([(el as HTMLAnchorElement).href], seen, out);
  } else if (tag === 'object') {
    const data = el.getAttribute('data');
    if (data) collect([data], seen, out);
  } else if (tag === 'embed') {
    const src = el.getAttribute('src');
    if (src) collect([src], seen, out);
  } else if (tag === 'picture') {
    for (const s of el.querySelectorAll('source[srcset]')) {
      collect(parseSrcset(s.getAttribute('srcset')), seen, out);
    }
  }

  // Computed styles (background / mask etc.) + pseudo-elements for [style] elements.
  // Static backgrounds defined by external stylesheets are covered by the CSSOM walk
  // (extractFromStyleSheets), so we avoid calling getComputedStyle() on every element.
  if (el.hasAttribute('style')) {
    const computed = window.getComputedStyle(el);
    for (const prop of IMAGE_STYLE_PROPERTIES) {
      collect(extractUrlsFromStyleValue(computed[prop]), seen, out);
    }
    for (const pseudo of ['::before', '::after'] as const) {
      const ps = window.getComputedStyle(el, pseudo);
      for (const prop of IMAGE_STYLE_PROPERTIES) {
        collect(extractUrlsFromStyleValue(ps[prop]), seen, out);
      }
    }
  }
}

function collectStyleUrls(
  style: CSSStyleDeclaration,
  seen: Set<string>,
  out: DomImageCandidate[]
): void {
  if (!style) return;
  collect(extractUrlsFromStyleValue(style.backgroundImage), seen, out);
  collect(extractUrlsFromStyleValue(style.background), seen, out);
  collect(extractUrlsFromStyleValue(style.maskImage), seen, out);
  collect(extractUrlsFromStyleValue(style.mask), seen, out);
}

// Walk stylesheet rules (including @media/@supports nested rules), picking up
// background-image declarations that are not present on any element yet.
function extractFromStyleSheets(
  seen: Set<string>,
  out: DomImageCandidate[]
): void {
  const walkRules = (ruleList: CSSRuleList | undefined): void => {
    if (!ruleList) return;
    for (const rule of Array.from(ruleList)) {
      const style = (rule as CSSStyleRule).style;
      if (style) collectStyleUrls(style, seen, out);
      const grouping = rule as CSSGroupingRule;
      if (grouping && typeof grouping.cssRules !== 'undefined') {
        try {
          walkRules(grouping.cssRules);
        } catch {
          /* ignore cross-origin stylesheets */
        }
      }
    }
  };

  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | undefined;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin stylesheet
      }
      if (!rules) continue;
      try {
        walkRules(rules);
      } catch {
        /* ignore unreadable rules */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Full-page extraction (initial scan). */
export function extractDomImages(): DomImageCandidate[] {
  const seen = new Set<string>();
  const out: DomImageCandidate[] = [];

  const elements = Array.from(
    document.querySelectorAll<Element>(CANDIDATE_SELECTOR)
  );
  let styleElementsSeen = 0;
  for (const el of elements) {
    if (el.hasAttribute('style')) {
      if (styleElementsSeen >= MAX_STYLE_ELEMENTS_PER_SCAN) {
        // Still collect non-style candidates, but skip the expensive computed-style walk
        if (el.tagName.toLowerCase() === 'img')
          extractFromElement(el, seen, out);
        continue;
      }
      styleElementsSeen++;
    }
    extractFromElement(el, seen, out);
  }

  extractFromStyleSheets(seen, out);
  return out;
}

/** Incremental extraction limited to a mutated subtree (MutationObserver). */
export function extractDomImagesInSubtree(root: Node): DomImageCandidate[] {
  const seen = new Set<string>();
  const out: DomImageCandidate[] = [];

  const collectNode = (node: Node): void => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.matches(CANDIDATE_SELECTOR)) {
      extractFromElement(el, seen, out);
    }
    if (el.querySelectorAll) {
      for (const child of Array.from(
        el.querySelectorAll<Element>(CANDIDATE_SELECTOR)
      )) {
        extractFromElement(child, seen, out);
      }
    }
  };

  collectNode(root);
  // The subtree also matters when an img is inserted without an [style] wrapper;
  // querySelectorAll on the subtree covers it. Stylesheets are not re-walked
  // incrementally (rarely mutated); periodic rescans catch any additions.
  return out;
}
