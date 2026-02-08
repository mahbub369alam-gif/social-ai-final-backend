import axios from "axios";
import * as cheerio from "cheerio";

export type WebsiteProduct = {
  name: string;
  priceText: string;   // e.g. "৳2,500" or "2500 BDT"
  currency?: string;   // "BDT" if detected
  url?: string;
};

type Cache = {
  url: string;
  refreshedAt: number;
  products: WebsiteProduct[];
};

let CACHE: Cache | null = null;

const normalize = (s: string) => String(s || "").replace(/\s+/g, " ").trim();

const looksLikeBDT = (s: string) => /৳|BDT|Tk|Taka/i.test(s);
const extractPriceSnippets = (text: string) => {
  // catches: ৳2500, ৳ 2,500, 2500 BDT, Tk 2500, 2500 taka
  const t = text || "";
  const matches = t.match(/(৳\s?\d[\d,.\s]*|\b\d[\d,.\s]*\s?(BDT|Tk|Taka)\b)/gi) || [];
  return matches.map((m) => normalize(m));
};

const uniqBy = <T>(arr: T[], keyFn: (x: T) => string) => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
};

async function fetchHtml(url: string): Promise<string> {
  const res = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Social-AI-Bot)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  return String(res.data || "");
}

function parseJsonLdProducts($: cheerio.CheerioAPI): WebsiteProduct[] {
  const products: WebsiteProduct[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (!raw) return;
    try {
      const data = JSON.parse(raw);

      const handleOne = (obj: any) => {
        if (!obj) return;

        // If @graph exists
        if (Array.isArray(obj["@graph"])) {
          obj["@graph"].forEach(handleOne);
          return;
        }

        const t = obj["@type"];
        const isProduct =
          t === "Product" ||
          (Array.isArray(t) && t.includes("Product"));

        if (!isProduct) return;

        const name = normalize(obj.name || "");
        if (!name) return;

        // offers could be object or array
        const offers = obj.offers;
        const offer = Array.isArray(offers) ? offers[0] : offers;

        let priceText = "";
        let currency = "";

        if (offer) {
          const price = offer.price ?? offer.lowPrice ?? offer.highPrice;
          currency = normalize(offer.priceCurrency || "");
          if (price !== undefined && price !== null) {
            priceText = normalize(String(price));
            if (currency) priceText = `${priceText} ${currency}`;
          }
        }

        // fallback: scan description
        if (!priceText) {
          const desc = normalize(obj.description || "");
          const snips = extractPriceSnippets(desc);
          if (snips.length) priceText = snips[0];
        }

        if (priceText) {
          products.push({
            name,
            priceText,
            currency: currency || (looksLikeBDT(priceText) ? "BDT" : undefined),
            url: normalize(obj.url || ""),
          });
        }
      };

      if (Array.isArray(data)) data.forEach(handleOne);
      else handleOne(data);
    } catch {
      // ignore invalid JSON-LD blocks
    }
  });

  return products;
}

function parseDomHeuristics($: cheerio.CheerioAPI): WebsiteProduct[] {
  // Generic fallback: find product-ish blocks and scan for price tokens
  const products: WebsiteProduct[] = [];

  const candidates = [
    "[class*='product']",
    "[class*='Product']",
    "article",
    "li",
    "div",
  ];

  const seenText = new Set<string>();

  for (const sel of candidates) {
    $(sel).each((_, el) => {
      const blockText = normalize($(el).text());
      if (!blockText || blockText.length < 20) return;
      if (seenText.has(blockText)) return;
      seenText.add(blockText);

      const prices = extractPriceSnippets(blockText);
      if (!prices.length) return;

      // guess name: first strong/h2/h3/a text in block
      let name =
        normalize($(el).find("h1,h2,h3,h4,strong,a").first().text()) ||
        normalize(blockText.split(" ").slice(0, 8).join(" "));

      name = normalize(name);
      if (!name) return;

      const priceText = prices[0];

      // link
      const href = $(el).find("a[href]").first().attr("href");
      const url = href ? normalize(String(href)) : "";

      products.push({
        name,
        priceText,
        currency: looksLikeBDT(priceText) ? "BDT" : undefined,
        url,
      });
    });
  }

  return products;
}

export async function refreshWebsiteCatalog(url: string) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const fromLd = parseJsonLdProducts($);
  const fromDom = parseDomHeuristics($);

  const merged = uniqBy([...fromLd, ...fromDom], (p) => `${p.name}::${p.priceText}`);

  CACHE = {
    url,
    refreshedAt: Date.now(),
    products: merged.slice(0, 500),
  };

  return CACHE;
}

export function getWebsiteCatalog() {
  return CACHE;
}

export function ensureWebsiteCatalogFresh(opts?: { maxAgeMs?: number }) {
  const maxAgeMs = opts?.maxAgeMs ?? 6 * 60 * 60 * 1000; // default 6 hours
  if (!CACHE) return false;
  return Date.now() - CACHE.refreshedAt <= maxAgeMs;
}

export function findProductPriceAnswer(query: string) {
  const q = normalize(query).toLowerCase();
  if (!CACHE || !CACHE.products.length || !q) return null;

  // basic matching: contains product name tokens
  // score by overlap
  const scored = CACHE.products
    .map((p) => {
      const name = normalize(p.name).toLowerCase();
      const tokens = name.split(" ").filter(Boolean);
      const hits = tokens.filter((t) => t.length >= 3 && q.includes(t)).length;
      return { p, hits, nameLen: name.length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.nameLen - b.nameLen);

  if (!scored.length) return null;

  const best = scored[0].p;
  const priceLine = best.priceText
    ? (looksLikeBDT(best.priceText) ? best.priceText : `${best.priceText}`)
    : "";

  if (!priceLine) return null;

  return {
    productName: best.name,
    priceText: priceLine,
    url: best.url || CACHE.url,
    refreshedAt: CACHE.refreshedAt,
  };
}
