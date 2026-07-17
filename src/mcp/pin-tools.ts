/**
 * Pin-equivalent tools exposed to Hermes over MCP.
 *
 * Hermes owns the agent loop. These tools give Hermes access to:
 * - weather / reverse_geocode / nearby_search (public APIs)
 * - pin photos as base64 (fetched from Penumbra HTTP on the pin)
 *
 * Live shutter ("take a photo now") still requires the pin camera pipeline
 * (UnderstandScene / AnalyzeImage). Until that is exposed over HTTP, photo
 * tools read the latest captured memory from the pin.
 */

import type { RegisteredTool } from "./store.js";

const USER_AGENT = "starlight-bridge/0.1 (penumbra-pin-tools; contact: wobo@boondit.site)";

export interface PinToolsOptions {
  /** Base URL of the pin's Penumbra HTTP API, e.g. http://penumbra.local:8080 */
  pinBaseUrl?: string;
  /** Max base64 chars returned (default ~350k ~260KB jpeg). */
  maxBase64Chars?: number;
}

let pinBaseUrl = "http://penumbra.local:8080";
let maxBase64Chars = 350_000;

export function configurePinTools(opts: PinToolsOptions): void {
  if (opts.pinBaseUrl) {
    pinBaseUrl = opts.pinBaseUrl.replace(/\/$/, "");
  }
  if (opts.maxBase64Chars && opts.maxBase64Chars > 10_000) {
    maxBase64Chars = opts.maxBase64Chars;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return resp.json();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

function num(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Missing or invalid number: ${name}`);
  }
  return n;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunk to avoid call-stack limits on large images
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Open-Meteo current weather (no API key). */
async function weatherHandler(args: Record<string, unknown>): Promise<unknown> {
  const latitude = num(args.latitude, "latitude");
  const longitude = num(args.longitude, "longitude");
  const requestType = str(args.request_type, "current");
  const units = str(args.units, "fahrenheit");
  const tempUnit = units === "celsius" ? "celsius" : "fahrenheit";

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
    `&temperature_unit=${tempUnit}&wind_speed_unit=mph&timezone=auto&forecast_days=5`;

  const data = (await fetchJson(url)) as {
    current?: Record<string, unknown>;
    daily?: Record<string, unknown[]>;
    timezone?: string;
  };

  const current = data.current ?? {};
  const daily = data.daily ?? {};

  if (requestType === "alerts") {
    return {
      latitude,
      longitude,
      request_type: "alerts",
      alerts: [],
      note: "Open-Meteo free endpoint does not provide alerts.",
    };
  }

  const forecastDays: Array<Record<string, unknown>> = [];
  const times = (daily.time as string[] | undefined) ?? [];
  for (let i = 0; i < times.length; i++) {
    forecastDays.push({
      date: times[i],
      high: daily.temperature_2m_max?.[i],
      low: daily.temperature_2m_min?.[i],
      precip_chance: daily.precipitation_probability_max?.[i],
      weather_code: daily.weather_code?.[i],
    });
  }

  return {
    latitude,
    longitude,
    timezone: data.timezone,
    request_type: requestType,
    units: tempUnit,
    current: {
      temperature: current.temperature_2m,
      feels_like: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      wind_speed_mph: current.wind_speed_10m,
      precipitation: current.precipitation,
      weather_code: current.weather_code,
      summary: weatherCodeToSummary(Number(current.weather_code ?? 0)),
    },
    daily: requestType === "current" ? [] : forecastDays,
  };
}

function weatherCodeToSummary(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return `Weather code ${code}`;
}

/** OpenStreetMap Nominatim reverse geocode. */
async function reverseGeocodeHandler(args: Record<string, unknown>): Promise<unknown> {
  const latitude = num(args.latitude, "latitude");
  const longitude = num(args.longitude, "longitude");
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=16&addressdetails=1`;
  const data = (await fetchJson(url)) as {
    display_name?: string;
    name?: string;
    address?: Record<string, string>;
  };
  const address = data.address ?? {};
  return {
    latitude,
    longitude,
    display_name: data.display_name ?? null,
    name: data.name ?? null,
    city: address.city ?? address.town ?? address.village ?? address.hamlet ?? null,
    state: address.state ?? null,
    country: address.country ?? null,
    postcode: address.postcode ?? null,
    address,
  };
}

/** Overpass nearby places search with multi-mirror fallback. */
async function nearbySearchHandler(args: Record<string, unknown>): Promise<unknown> {
  const latitude = num(args.latitude, "latitude");
  const longitude = num(args.longitude, "longitude");
  const radius = Math.min(Math.max(Number(args.radius_meters ?? 1000) || 1000, 50), 5000);
  const rawQuery = str(args.query, "").trim();

  // Map common category words to OSM tag filters so "coffee" finds amenity=cafe,
  // "gas" finds amenity=fuel, etc. Falls back to a name regex for unmapped queries.
  const CATEGORY_MAP: Record<string, string[]> = {
    coffee: ['["amenity"="cafe"]', '["shop"="coffee"]'],
    cafe: ['["amenity"="cafe"]'],
    restaurant: ['["amenity"="restaurant"]', '["amenity"="fast_food"]'],
    food: ['["amenity"="restaurant"]', '["amenity"="fast_food"]', '["amenity"="cafe"]', '["shop"="bakery"]'],
    bar: ['["amenity"="bar"]', '["amenity"="pub"]'],
    pub: ['["amenity"="pub"]'],
    gas: ['["amenity"="fuel"]'],
    fuel: ['["amenity"="fuel"]'],
    gas_station: ['["amenity"="fuel"]'],
    pharmacy: ['["amenity"="pharmacy"]', '["healthcare"="pharmacy"]'],
    store: ['["shop"]'],
    shop: ['["shop"]'],
    shopping: ['["shop"]', '["shop"="mall"]'],
    grocery: ['["shop"="supermarket"]', '["shop"="convenience"]'],
    supermarket: ['["shop"="supermarket"]'],
    hotel: ['["tourism"="hotel"]'],
    atm: ['["amenity"="atm"]', '["amenity"="bank"]'],
    bank: ['["amenity"="bank"]'],
    hospital: ['["amenity"="hospital"]', '["amenity"="clinic"]'],
    doctor: ['["amenity"="doctors"]', '["amenity"="clinic"]'],
    park: ['["leisure"="park"]', '["leisure"="garden"]'],
    school: ['["amenity"="school"]'],
    gym: ['["leisure"="fitness_centre"]', '["sport"="fitness"]'],
    fitness: ['["leisure"="fitness_centre"]'],
    pizza: ['["amenity"="restaurant"]["cuisine"~"pizza",i]', '["amenity"="fast_food"]["cuisine"~"pizza",i]'],
    mexican: ['["amenity"["cuisine"~"mexican",i]'],
    chinese: ['["amenity"["cuisine"~"chinese",i]'],
    sushi: ['["amenity"["cuisine"~"sushi|japanese",i]'],
    charging: ['["amenity"="charging_station"]'],
    ev: ['["amenity"="charging_station"]'],
    parking: ['["amenity"="parking"]'],
    toilet: ['["amenity"="toilets"]'],
    bathroom: ['["amenity"="toilets"]'],
  };

  const queryLower = rawQuery.toLowerCase().replace(/\s+/g, "_");
  const categoryFilters = CATEGORY_MAP[queryLower];
  const nameFilter = rawQuery
    ? `["name"~"${rawQuery.replace(/"/g, "")}",i]`
    : "";

  let filters: string;
  if (categoryFilters) {
    // Use specific OSM tag filters for known categories
    filters = categoryFilters.map(f => `node${f}(around:${radius},${latitude},${longitude});`).join("");
  } else {
    // General search: amenities/shops/tourism with optional name filter
    filters =
      `node["amenity"]${nameFilter}(around:${radius},${latitude},${longitude});` +
      `node["shop"]${nameFilter}(around:${radius},${latitude},${longitude});` +
      `node["tourism"]${nameFilter}(around:${radius},${latitude},${longitude});`;
  }

  const overpass = `[out:json][timeout:15];(${filters});out body 10;`;

  // The main overpass-api.de is frequently overloaded. Try mirrors in order.
  const mirrors = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
  ];

  type OverpassData = { elements?: Array<{ lat?: number; lon?: number; tags?: Record<string, string> }> };
  let data: OverpassData | null = null;
  let lastError = "";

  for (const mirror of mirrors) {
    try {
      const resp = await fetch(mirror, {
        method: "POST",
        signal: AbortSignal.timeout(12000),
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `data=${encodeURIComponent(overpass)}`,
      });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} from ${mirror}`;
        continue;
      }
      data = (await resp.json()) as OverpassData;
      break;
    } catch (err) {
      lastError = `${mirror}: ${(err as Error).message}`;
      continue;
    }
  }

  if (!data) {
    return {
      places: [],
      query: rawQuery || null,
      radius_meters: radius,
      latitude,
      longitude,
      error: `All Overpass mirrors failed. Last error: ${lastError}`,
    };
  }

  const places = (data.elements ?? [])
    .filter((e) => e.lat != null && e.lon != null)
    .slice(0, 10)
    .map((e) => {
      const tags = e.tags ?? {};
      const streetParts = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean);
      const address =
        tags["addr:full"] ?? (streetParts.length > 0 ? streetParts.join(" ") : null);
      // Distance from the search center (haversine, approximate)
      const distM = haversineMeters(latitude, longitude, e.lat!, e.lon!);
      return {
        name: tags.name ?? tags.amenity ?? tags.shop ?? tags.tourism ?? "Unknown",
        description: tags.amenity ?? tags.shop ?? tags.tourism ?? null,
        address,
        latitude: e.lat,
        longitude: e.lon,
        distance_meters: Math.round(distM),
        website_url: tags.website ?? tags.url ?? null,
      };
    })
    .sort((a, b) => (a.distance_meters ?? 0) - (b.distance_meters ?? 0));

  return { places, query: rawQuery || null, radius_meters: radius, latitude, longitude };
}

/** Approximate distance in meters between two lat/lon points. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Pin photo tools ────────────────────────────────────────────────

interface PinMemory {
  uuid: string;
  memory_type?: string;
  created_at?: string;
  status?: string;
  thumbnail_count?: number;
  files?: string[];
  location?: { latitude?: number; longitude?: number; human_readable?: string };
}

async function listPinMemories(): Promise<PinMemory[]> {
  const data = await fetchJson(`${pinBaseUrl}/api/memories`);
  if (!Array.isArray(data)) {
    throw new Error("pin /api/memories did not return an array");
  }
  return data as PinMemory[];
}

function pickLatestPhoto(memories: PinMemory[]): PinMemory {
  const photos = memories.filter(
    (m) => (m.memory_type === "photo" || !m.memory_type) && (m.thumbnail_count ?? 0) > 0,
  );
  if (photos.length === 0) {
    throw new Error("No photos with thumbnails found on the pin");
  }
  // created_at is epoch seconds string on pin
  photos.sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
  return photos[0];
}

async function loadThumbnailBase64(
  uuid: string,
  index: number,
): Promise<{ base64: string; bytes: number; truncated: boolean; mime: string }> {
  const bytes = await fetchBytes(
    `${pinBaseUrl}/api/memories/${encodeURIComponent(uuid)}/thumbnail/${index}`,
  );
  let b64 = bytesToBase64(bytes);
  let truncated = false;
  if (b64.length > maxBase64Chars) {
    // Prefer smaller later thumbnails if available? For now just truncate with note.
    // Better: try a later index only at call sites. Keep full if under cap.
    truncated = true;
    b64 = b64.slice(0, maxBase64Chars);
  }
  return {
    base64: b64,
    bytes: bytes.length,
    truncated,
    mime: "image/jpeg",
  };
}

async function getLatestPhotoHandler(args: Record<string, unknown>): Promise<unknown> {
  const includeBase64 = args.include_base64 !== false;
  const index = Math.max(0, Math.floor(Number(args.thumbnail_index ?? 0) || 0));
  const mem = pickLatestPhoto(await listPinMemories());

  const meta = {
    uuid: mem.uuid,
    created_at: mem.created_at ?? null,
    status: mem.status ?? null,
    location: mem.location ?? null,
    thumbnail_count: mem.thumbnail_count ?? 0,
    pin_base_url: pinBaseUrl,
    note:
      "This is the latest photo memory on the pin (not a live shutter trigger). " +
      "Live capture still goes through the pin's UnderstandScene/AnalyzeImage path.",
  };

  if (!includeBase64) {
    return {
      ...meta,
      image_url: `${pinBaseUrl}/api/memories/${mem.uuid}/thumbnail/${index}`,
    };
  }

  const image = await loadThumbnailBase64(mem.uuid, index);
  return {
    ...meta,
    mime: image.mime,
    byte_length: image.bytes,
    truncated: image.truncated,
    // data URL form for models that accept image URLs; raw base64 also included
    data_url: `data:${image.mime};base64,${image.base64}`,
    base64: image.base64,
  };
}

async function getPhotoHandler(args: Record<string, unknown>): Promise<unknown> {
  const uuid = str(args.uuid).trim();
  if (!uuid) throw new Error("uuid is required");
  const index = Math.max(0, Math.floor(Number(args.thumbnail_index ?? 0) || 0));
  const includeBase64 = args.include_base64 !== false;

  const mem = (await listPinMemories()).find((m) => m.uuid === uuid);
  if (!mem) throw new Error(`Photo memory not found: ${uuid}`);

  const meta = {
    uuid: mem.uuid,
    created_at: mem.created_at ?? null,
    status: mem.status ?? null,
    location: mem.location ?? null,
    thumbnail_count: mem.thumbnail_count ?? 0,
    files: mem.files ?? [],
  };

  if (!includeBase64) {
    return {
      ...meta,
      image_url: `${pinBaseUrl}/api/memories/${uuid}/thumbnail/${index}`,
    };
  }

  const image = await loadThumbnailBase64(uuid, index);
  return {
    ...meta,
    mime: image.mime,
    byte_length: image.bytes,
    truncated: image.truncated,
    data_url: `data:${image.mime};base64,${image.base64}`,
    base64: image.base64,
  };
}

async function listPhotosHandler(args: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50);
  const photos = (await listPinMemories())
    .filter((m) => m.memory_type === "photo" || (m.thumbnail_count ?? 0) > 0)
    .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
    .slice(0, limit)
    .map((m) => ({
      uuid: m.uuid,
      created_at: m.created_at ?? null,
      status: m.status ?? null,
      thumbnail_count: m.thumbnail_count ?? 0,
      location: m.location ?? null,
      thumbnail_url: `${pinBaseUrl}/api/memories/${m.uuid}/thumbnail/0`,
    }));
  return { count: photos.length, photos };
}


/**
 * Ask the Pin to open the camera through Penumbra's deferred-vision protocol.
 *
 * This tool is deliberately action-only. It MUST return the sentinel immediately:
 * waiting here deadlocks because AnalyzeImage cannot happen until this turn ends and
 * Penumbra converts the sentinel into an UnderstandScene action.
 *
 * After capture, the Pin sends AnalyzeImage and then a follow-up Understand request.
 * Penumbra's LiveImageStore attaches that image to the follow-up LLM turn.
 */
async function requestPinCameraHandler(args: Record<string, unknown>): Promise<unknown> {
  const question = str(args.question, "What do you see?");
  return {
    status: "deferred_vision_requested",
    question,
    deferred_vision_marker: "__HUMANE_DEFERRED_VISION__",
    instructions: "End this turn with exactly __HUMANE_DEFERRED_VISION__ and no other text.",
  };
}

async function waitForPinCameraHandler(args: Record<string, unknown>): Promise<unknown> {
  const timeoutSecs = Math.min(Math.max(Number(args.timeout_secs ?? 25) || 25, 1), 60);
  const afterGeneration = Math.max(0, Math.floor(Number(args.after_generation ?? 0) || 0));
  const url =
    `${pinBaseUrl}/api/photos/wait?timeout_secs=${timeoutSecs}&after_generation=${afterGeneration}`;
  const data = await fetchJson(url);
  return data;
}

// ─── Device status / connectivity / unit conversion ────────────────

/** GET /api/device — battery, thermal, OS/server versions. */
async function pinDeviceStatusHandler(): Promise<unknown> {
  const data = await fetchJson(`${pinBaseUrl}/api/device`);
  return data;
}

/** GET /api/cellular/service-status — signal, operator, data state. */
async function pinCellularStatusHandler(): Promise<unknown> {
  const data = await fetchJson(`${pinBaseUrl}/api/cellular/service-status`);
  return data;
}

/** PUT /api/wifi/set-enabled — toggle WiFi on/off. */
async function pinToggleWifiHandler(args: Record<string, unknown>): Promise<unknown> {
  const enabled = Boolean(args.enabled);
  const resp = await fetch(`${pinBaseUrl}/api/wifi/set-enabled`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ enabled }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep raw text */ }
  return { ok: resp.ok, status: resp.status, enabled, result: body };
}

/** PUT /api/cellular/set-enabled — toggle cellular data on/off. */
async function pinToggleCellularHandler(args: Record<string, unknown>): Promise<unknown> {
  const enabled = Boolean(args.enabled);
  const resp = await fetch(`${pinBaseUrl}/api/cellular/set-enabled`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ enabled }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep raw text */ }
  return { ok: resp.ok, status: resp.status, enabled, result: body };
}

/** Unit conversion and basic math via a lightweight local evaluator. */
async function unitConvertHandler(args: Record<string, unknown>): Promise<unknown> {
  const expr = str(args.expression).trim();
  if (!expr) throw new Error("expression is required");

  // Temperature conversions
  const tempMatch = expr.match(/^(-?\d+(?:\.\d+)?)\s*(c|celsius|f|fahrenheit|k|kelvin)\s*(?:to|in|->?)\s*(c|celsius|f|fahrenheit|k|kelvin)$/i);
  if (tempMatch) {
    const val = parseFloat(tempMatch[1]);
    const from = tempMatch[2].toLowerCase()[0];
    const to = tempMatch[3].toLowerCase()[0];
    let celsius: number;
    if (from === "f") celsius = (val - 32) * 5 / 9;
    else if (from === "k") celsius = val - 273.15;
    else celsius = val;
    let result: number;
    if (to === "f") result = celsius * 9 / 5 + 32;
    else if (to === "k") result = celsius + 273.15;
    else result = celsius;
    const unitName = { c: "C", f: "F", k: "K" }[to] ?? "";
    return { expression: expr, result: Math.round(result * 100) / 100, unit: unitName };
  }

  // General unit conversion via a conversion table
  const convMatch = expr.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*(?:to|in|->?)\s*([a-zA-Z]+)$/i);
  if (convMatch) {
    const val = parseFloat(convMatch[1]);
    const from = convMatch[2].toLowerCase();
    const to = convMatch[3].toLowerCase();
    const result = convertUnits(val, from, to);
    if (result !== null) return { expression: expr, result: Math.round(result * 10000) / 10000, from, to };
    return { expression: expr, error: `Cannot convert ${from} to ${to}` };
  }

  // Basic arithmetic
  const mathMatch = expr.match(/^[\d\s+\-*/().]+$/);
  if (mathMatch) {
    try {
      const result = Function(`"use strict"; return (${expr})`)();
      if (typeof result === "number" && Number.isFinite(result)) {
        return { expression: expr, result };
      }
    } catch { /* fall through */ }
  }

  return { expression: expr, error: "Could not parse expression. Try '72F to C', '100 meters to feet', or '2 + 3 * 4'." };
}

const UNIT_TABLE: Record<string, { category: string; factor: number }> = {
  // length (base: meters)
  m: { category: "length", factor: 1 }, meter: { category: "length", factor: 1 }, meters: { category: "length", factor: 1 },
  cm: { category: "length", factor: 0.01 },
  km: { category: "length", factor: 1000 },
  mm: { category: "length", factor: 0.001 },
  ft: { category: "length", factor: 0.3048 }, feet: { category: "length", factor: 0.3048 }, foot: { category: "length", factor: 0.3048 },
  in: { category: "length", factor: 0.0254 }, inch: { category: "length", factor: 0.0254 }, inches: { category: "length", factor: 0.0254 },
  mi: { category: "length", factor: 1609.344 }, mile: { category: "length", factor: 1609.344 }, miles: { category: "length", factor: 1609.344 },
  yd: { category: "length", factor: 0.9144 }, yard: { category: "length", factor: 0.9144 }, yards: { category: "length", factor: 0.9144 },
  // weight (base: grams)
  g: { category: "weight", factor: 1 }, gram: { category: "weight", factor: 1 }, grams: { category: "weight", factor: 1 },
  kg: { category: "weight", factor: 1000 },
  mg: { category: "weight", factor: 0.001 },
  lb: { category: "weight", factor: 453.592 }, lbs: { category: "weight", factor: 453.592 }, pound: { category: "weight", factor: 453.592 }, pounds: { category: "weight", factor: 453.592 },
  oz: { category: "weight", factor: 28.3495 }, ounce: { category: "weight", factor: 28.3495 }, ounces: { category: "weight", factor: 28.3495 },
  // volume (base: liters)
  l: { category: "volume", factor: 1 }, liter: { category: "volume", factor: 1 }, liters: { category: "volume", factor: 1 },
  ml: { category: "volume", factor: 0.001 },
  gal: { category: "volume", factor: 3.78541 }, gallon: { category: "volume", factor: 3.78541 }, gallons: { category: "volume", factor: 3.78541 },
  cup: { category: "volume", factor: 0.236588 }, cups: { category: "volume", factor: 0.236588 },
  // speed (base: m/s)
  mps: { category: "speed", factor: 1 },
  mph: { category: "speed", factor: 0.44704 },
  kph: { category: "speed", factor: 0.277778 }, kmh: { category: "speed", factor: 0.277778 },
};

function convertUnits(val: number, from: string, to: string): number | null {
  const f = UNIT_TABLE[from];
  const t = UNIT_TABLE[to];
  if (!f || !t || f.category !== t.category) return null;
  const baseVal = val * f.factor;
  return baseVal / t.factor;
}


/** Build the pin tool set for MCP registration. */
export function buildPinTools(): RegisteredTool[] {
  return [
    {
      name: "weather",
      description:
        "Get weather for a latitude and longitude, including current conditions and daily forecasts. Use current for now, forecast for later today/this week. Coordinates are usually available from the user status context.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "Latitude for the weather location. Required." },
          longitude: { type: "number", description: "Longitude for the weather location. Required." },
          request_type: {
            type: "string",
            enum: ["current", "forecast", "historical", "alerts"],
            description: "current | forecast | historical | alerts",
          },
          time: {
            type: "string",
            description: "Optional ISO 8601 for historical only.",
          },
          units: {
            type: "string",
            enum: ["fahrenheit", "celsius"],
            description: "Temperature units. Defaults to fahrenheit.",
          },
        },
        required: ["latitude", "longitude", "request_type"],
      },
      handler: weatherHandler,
    },
    {
      name: "reverse_geocode",
      description:
        "Look up the human-readable address or place name for latitude and longitude. Use for where am I / what city am I in.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "Latitude to reverse geocode." },
          longitude: { type: "number", description: "Longitude to reverse geocode." },
        },
        required: ["latitude", "longitude"],
      },
      handler: reverseGeocodeHandler,
    },
    {
      name: "nearby_search",
      description:
        "Search for nearby places (amenities, shops, tourism) around coordinates. Optional free-text query.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
          radius_meters: { type: "number", description: "Search radius in meters (default 1000)." },
          query: { type: "string", description: "Optional place name / category filter." },
        },
        required: ["latitude", "longitude"],
      },
      handler: nearbySearchHandler,
    },
    {
      name: "list_pin_photos",
      description:
        "List recent photos captured by the Humane AI Pin (memory store). Returns metadata and thumbnail URLs, not base64. Use get_latest_pin_photo or get_pin_photo to fetch image bytes.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max photos to return (default 10, max 50)." },
        },
        required: [],
      },
      handler: listPhotosHandler,
    },
    {
      name: "get_latest_pin_photo",
      description:
        "Fetch the most recent photo from the Pin as a base64 JPEG (and data URL). Use when the user asks what they just took a picture of, or to analyze the latest pin photo. This is NOT a live shutter — it reads the latest stored memory. For live capture the pin must trigger camera via UnderstandScene first.",
      inputSchema: {
        type: "object",
        properties: {
          include_base64: {
            type: "boolean",
            description: "Include base64/data_url (default true). Set false for metadata only.",
          },
          thumbnail_index: {
            type: "number",
            description: "Thumbnail index 0..n-1 (default 0).",
          },
        },
        required: [],
      },
      handler: getLatestPhotoHandler,
    },
    {
      name: "get_pin_photo",
      description:
        "Fetch a specific Pin photo by memory UUID as base64 JPEG. Use after list_pin_photos.",
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Memory UUID of the photo." },
          include_base64: {
            type: "boolean",
            description: "Include base64/data_url (default true).",
          },
          thumbnail_index: {
            type: "number",
            description: "Thumbnail index 0..n-1 (default 0).",
          },
        },
        required: ["uuid"],
      },
      handler: getPhotoHandler,
    },
    {
      name: "request_pin_camera",
      description:
        "Trigger the Humane AI Pin camera for live visual understanding. Call once, then end the turn with exactly the returned deferred_vision_marker. Do not wait or call another tool in this turn. Penumbra will open the camera, receive AnalyzeImage, and provide the image in a follow-up Understand turn.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "What to look for / question about the scene.",
          },
        },
        required: [],
      },
      handler: requestPinCameraHandler,
    },
    {
      name: "wait_for_pin_camera",
      description:
        "Wait for the next live pin camera frame (AnalyzeImage) and return it as base64 JPEG. Use after returning __HUMANE_DEFERRED_VISION__ so the pin has been told to capture.",
      inputSchema: {
        type: "object",
        properties: {
          timeout_secs: { type: "number", description: "Wait timeout seconds (default 25)." },
          after_generation: {
            type: "number",
            description: "Only return captures newer than this generation id.",
          },
        },
        required: [],
      },
      handler: waitForPinCameraHandler,
    },
    {
      name: "pin_device_status",
      description:
        "Get the pin's device status including battery level, thermal state, OS version, display name, server version, and installed component versions. Use for 'what's my battery' or general device info.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: pinDeviceStatusHandler,
    },
    {
      name: "pin_cellular_status",
      description:
        "Check cellular service status on the pin: signal strength, operator, data connection state, and whether cellular is usable.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: pinCellularStatusHandler,
    },
    {
      name: "pin_toggle_wifi",
      description:
        "Enable or disable WiFi on the pin. Use when the user asks to turn wifi on or off.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "true to enable WiFi, false to disable.",
          },
        },
        required: ["enabled"],
      },
      handler: pinToggleWifiHandler,
    },
    {
      name: "pin_toggle_cellular",
      description:
        "Enable or disable cellular data on the pin. Use when the user asks to turn cellular/mobile data on or off.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "true to enable cellular, false to disable.",
          },
        },
        required: ["enabled"],
      },
      handler: pinToggleCellularHandler,
    },
    {
      name: "unit_convert",
      description:
        "Convert between units or perform quick math. Handles temperature, length, weight, volume, speed, and time conversions, plus basic arithmetic. Use for 'how many feet in 100 meters' or 'convert 72 f to c'.",
      inputSchema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "The conversion or math expression, e.g. '72F to C', '100 meters to feet', '2 + 3 * 4'.",
          },
        },
        required: ["expression"],
      },
      handler: unitConvertHandler,
    },
  ];
}
