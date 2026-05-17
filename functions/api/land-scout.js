export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const url = String(body.url || "").trim();

    if (!url) {
      return jsonResponse({ ok: false, error: "Missing URL." }, 400);
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch {
      return jsonResponse({ ok: false, error: "Invalid URL." }, 400);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return jsonResponse(
        { ok: false, error: "Only http and https URLs are allowed." },
        400
      );
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (!response.ok) {
      return jsonResponse(
        {
          ok: false,
          error: `Could not fetch listing. Source returned ${response.status}. This site may be blocking automated reads.`
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

  const combined = cleanText(`${title}\n${description}\n${text}`);

  const jsonLdData = extractJsonLd(html);

  const price =
    findPriceFromJsonLd(jsonLdData) ||
    findPrice(combined);

  const acres = findAcres(combined);
  const state = findState(combined);
  const county = findCounty(combined);

  const roadAccess = findRoadAccess(combined);
  const multipleHomes = findMultipleHomes(combined);
  const septicWater = findSepticWater(combined);
  const floodWetlands = findFloodWetlands(combined);
  const utilities = findUtilities(combined);
  const selfReliance = findSelfReliance(combined);

  const pricePerAcre = price && acres ? Math.round(price / acres) : null;

  return {
    title: cleanText(title),
    description: cleanText(description),
    price,
    acres,
    pricePerAcre,
    state,
    county,
    roadAccess,
    multipleHomes,
    septicWater,
    floodWetlands,
    utilities,
    selfReliance,
    confidence: buildExtractionConfidence({
      price,
      acres,
      state,
      county,
      roadAccess,
      septicWater,
      utilities
    }),
    notes: buildExtractionNotes({
      price,
      acres,
      state,
      county,
      roadAccess,
      septicWater,
      utilities
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
  const matches = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis
    )
  ];

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
    /(?:price|asking|listed for)[^$0-9]{0,40}\$?\s?([0-9]{1,3}(?:,[0-9]{3})+)/i
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
    /size\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\+\/-|\+|-|±)?\s*acres?\b/i,
    /([0-9]+(?:\.[0-9]+)?)\s*(?:\+\/-|\+|-|±)?\s*acres?\b/i,
    /acres?\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /lot\s*size\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*acres?/i,
    /([0-9]+(?:\.[0-9]+)?)\s*acre\s+lot/i
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
  const states = {
    Alabama: "AL",
    Alaska: "AK",
    Arizona: "AZ",
    Arkansas: "AR",
    California: "CA",
    Colorado: "CO",
    Connecticut: "CT",
    Delaware: "DE",
    Florida: "FL",
    Georgia: "GA",
    Hawaii: "HI",
    Idaho: "ID",
    Illinois: "IL",
    Indiana: "IN",
    Iowa: "IA",
    Kansas: "KS",
    Kentucky: "KY",
    Louisiana: "LA",
    Maine: "ME",
    Maryland: "MD",
    Massachusetts: "MA",
    Michigan: "MI",
    Minnesota: "MN",
    Mississippi: "MS",
    Missouri: "MO",
    Montana: "MT",
    Nebraska: "NE",
    Nevada: "NV",
    "New Hampshire": "NH",
    "New Jersey": "NJ",
    "New Mexico": "NM",
    "New York": "NY",
    "North Carolina": "NC",
    "North Dakota": "ND",
    Ohio: "OH",
    Oklahoma: "OK",
    Oregon: "OR",
    Pennsylvania: "PA",
    "Rhode Island": "RI",
    "South Carolina": "SC",
    "South Dakota": "SD",
    Tennessee: "TN",
    Texas: "TX",
    Utah: "UT",
    Vermont: "VT",
    Virginia: "VA",
    Washington: "WA",
    "West Virginia": "WV",
    Wisconsin: "WI",
    Wyoming: "WY"
  };

  for (const [name, abbr] of Object.entries(states)) {
    const namePattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    const abbrPattern = new RegExp(`\\b${abbr}\\b`);

    if (namePattern.test(text) || abbrPattern.test(text)) {
      return abbr;
    }
  }

  return null;
}

function findCounty(text) {
  const patterns = [
    /\(\s*([A-Z][a-zA-Z\s.'-]+?)\s+County\s*\)/,
    /\b([A-Z][a-zA-Z\s.'-]+?)\s+County\b/,
    /county\s*[:\-]?\s*([A-Z][a-zA-Z\s.'-]+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return cleanText(match[1]).replace(/\s+/g, " ");
    }
  }

  return null;
}

function findRoadAccess(text) {
  if (/landlocked|no legal access|no road access/i.test(text)) return "no";
  if (/dirt road access|road access|paved road|county road|frontage|legal access/i.test(text)) return "yes";
  return "unknown";
}

function findMultipleHomes(text) {
  if (/single-family|single family|mobile homes?|manufactured homes?/i.test(text)) {
    return "maybe";
  }

  if (/multi-family|multiple homes|family compound|additional dwelling|adu/i.test(text)) {
    return "maybe";
  }

  if (/no mobile homes|single residence only|one dwelling/i.test(text)) {
    return "no";
  }

  return "unknown";
}

function findSepticWater(text) {
  if (/well and septic|well\s*&\s*septic|septic systems?|well water/i.test(text)) {
    return "maybe";
  }

  if (/public water|public sewer|sewer available|water available/i.test(text)) {
    return "yes";
  }

  if (/failed perc|no septic|septic not allowed/i.test(text)) {
    return "no";
  }

  return "unknown";
}

function findFloodWetlands(text) {
  if (/flood zone|wetlands|wetland|fema/i.test(text)) {
    return "medium";
  }

  if (/not in a flood zone|outside flood zone|no wetlands/i.test(text)) {
    return "low";
  }

  return "unknown";
}

function findUtilities(text) {
  if (/electricity nearby|nearby electricity|power nearby|electric available|utilities available/i.test(text)) {
    return "yes";
  }

  if (/off grid|no utilities|no power/i.test(text)) {
    return "no";
  }

  if (/power|electric|utilities/i.test(text)) {
    return "maybe";
  }

  return "unknown";
}

function findSelfReliance(text) {
  if (/farm|homestead|garden|livestock|chickens|solar|rural|acreage/i.test(text)) {
    return "medium";
  }

  return "unknown";
}

function buildExtractionConfidence(data) {
  let known = 0;
  let total = 7;

  if (data.price) known++;
  if (data.acres) known++;
  if (data.state) known++;
  if (data.county) known++;
  if (data.roadAccess && data.roadAccess !== "unknown") known++;
  if (data.septicWater && data.septicWater !== "unknown") known++;
  if (data.utilities && data.utilities !== "unknown") known++;

  const percent = Math.round((known / total) * 100);

  if (percent >= 75) return "High";
  if (percent >= 45) return "Medium";
  return "Low";
}

function buildExtractionNotes(data) {
  const notes = [];

  if (!data.price) notes.push("Price could not be detected.");
  if (!data.acres) notes.push("Acreage could not be detected.");
  if (!data.state) notes.push("State could not be detected.");
  if (!data.county) notes.push("County could not be detected.");
  if (!data.roadAccess || data.roadAccess === "unknown") {
    notes.push("Road access could not be verified from the listing text.");
  }
  if (!data.septicWater || data.septicWater === "unknown") {
    notes.push("Septic / water potential could not be verified from the listing text.");
  }
  if (!data.utilities || data.utilities === "unknown") {
    notes.push("Utility access could not be verified from the listing text.");
  }

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
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
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