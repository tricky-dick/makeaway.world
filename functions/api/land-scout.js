export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const url = String(body.url || "").trim();

    if (!url) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing URL."
        },
        400
      );
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid URL."
        },
        400
      );
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return jsonResponse(
        {
          ok: false,
          error: "Only http and https URLs are allowed."
        },
        400
      );
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 MakeawayLandScout/0.1 (+https://makeaway.world)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      return jsonResponse(
        {
          ok: false,
          error: `Could not fetch listing. Source returned ${response.status}.`
        },
        502
      );
    }

    const html = await response.text();

    const extracted = extractListingData(html, url);

    return jsonResponse({
      ok: true,
      sourceUrl: url,
      extracted
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error.message || "Unknown server error."
      },
      500
    );
  }
}

function extractListingData(html, url) {
  const text = htmlToPlainText(html);

  const title =
    getMetaContent(html, "og:title") ||
    getMetaContent(html, "twitter:title") ||
    getTitleTag(html) ||
    "Unknown listing";

  const description =
    getMetaContent(html, "og:description") ||
    getMetaContent(html, "description") ||
    getMetaContent(html, "twitter:description") ||
    "";

  const combined = `${title}\n${description}\n${text}`;

  const jsonLdData = extractJsonLd(html);

  const price =
    findPriceFromJsonLd(jsonLdData) ||
    findPrice(combined);

  const acres = findAcres(combined);
  const state = findState(combined);
  const county = findCounty(combined);

  const pricePerAcre =
    price && acres ? Math.round(price / acres) : null;

  return {
    title: cleanText(title),
    description: cleanText(description),
    price,
    acres,
    pricePerAcre,
    state,
    county,
    confidence: buildExtractionConfidence({
      price,
      acres,
      state,
      county
    }),
    notes: buildExtractionNotes({
      price,
      acres,
      state,
      county
    }),
    rawSourceDomain: new URL(url).hostname
  };
}

function getMetaContent(html, name) {
  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegExp(name)}["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRegExp(name)}["'][^>]*>`,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }

  return null;
}

function getTitleTag(html) {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/is);
  return match?.[1] ? decodeHtml(match[1]) : null;
}

function extractJsonLd(html) {
  const matches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis)];
  const parsed = [];

  for (const match of matches) {
    try {
      const raw = match[1].trim();
      const data = JSON.parse(raw);
      parsed.push(data);
    } catch {
      // Ignore bad JSON-LD blocks.
    }
  }

  return parsed;
}

function findPriceFromJsonLd(jsonLdData) {
  const possiblePrices = [];

  function walk(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    for (const [key, childValue] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();

      if (
        ["price", "lowprice", "highprice"].includes(lowerKey) &&
        typeof childValue !== "object"
      ) {
        const number = moneyToNumber(String(childValue));
        if (number) possiblePrices.push(number);
      }

      walk(childValue);
    }
  }

  jsonLdData.forEach(walk);

  return possiblePrices.length ? Math.max(...possiblePrices) : null;
}

function findPrice(text) {
  const patterns = [
    /\$\s?([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d{2})?)/i,
    /\$\s?([0-9]{5,9})(?:\.\d{2})?/i,
    /price[^$0-9]{0,20}\$?\s?([0-9]{1,3}(?:,[0-9]{3})+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const price = moneyToNumber(match[1]);
      if (price) return price;
    }
  }

  return null;
}

function findAcres(text) {
  const patterns = [
    /([0-9]+(?:\.[0-9]+)?)\s*(?:\+\/-|\+|-)?\s*acres?\b/i,
    /acres?\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /lot\s*size\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*acres?/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const acres = Number(match[1]);
      if (!Number.isNaN(acres) && acres > 0 && acres < 100000) {
        return acres;
      }
    }
  }

  return null;
}

function findState(text) {
  const statePatterns = [
    /\bGeorgia\b/i,
    /\bFlorida\b/i,
    /\bAlabama\b/i,
    /\bTennessee\b/i,
    /\bSouth Carolina\b/i,
    /\bNorth Carolina\b/i,
    /\bGA\b/,
    /\bFL\b/,
    /\bAL\b/,
    /\bTN\b/,
    /\bSC\b/,
    /\bNC\b/
  ];

  for (const pattern of statePatterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const value = match[0].toLowerCase();

    if (value === "georgia" || value === "ga") return "GA";
    if (value === "florida" || value === "fl") return "FL";
    if (value === "alabama" || value === "al") return "AL";
    if (value === "tennessee" || value === "tn") return "TN";
    if (value === "south carolina" || value === "sc") return "SC";
    if (value === "north carolina" || value === "nc") return "NC";
  }

  return null;
}

function findCounty(text) {
  const match = text.match(/\b([A-Z][a-zA-Z]+)\s+County\b/);
  return match?.[1] || null;
}

function buildExtractionConfidence(data) {
  let known = 0;

  if (data.price) known++;
  if (data.acres) known++;
  if (data.state) known++;
  if (data.county) known++;

  if (known >= 4) return "High";
  if (known >= 2) return "Medium";
  return "Low";
}

function buildExtractionNotes(data) {
  const notes = [];

  if (!data.price) notes.push("Price could not be detected.");
  if (!data.acres) notes.push("Acreage could not be detected.");
  if (!data.state) notes.push("State could not be detected.");
  if (!data.county) notes.push("County could not be detected.");

  if (!notes.length) {
    notes.push("Basic listing details were detected, but should still be verified.");
  }

  return notes;
}

function htmlToPlainText(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function moneyToNumber(value) {
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  const number = Number(cleaned);

  if (Number.isNaN(number) || number <= 0) return null;

  return Math.round(number);
}

function cleanText(value) {
  return decodeHtml(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8"
    }
  });
}