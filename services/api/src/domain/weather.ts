type WeatherConfig = {
  zip?: string;
  latitude?: number;
  longitude?: number;
  coldThresholdF?: number;
  forecastHours?: number;
  pickupRadiusMiles?: number;
};

type DealerProfileLike = {
  address?: { zip?: string };
  weather?: WeatherConfig;
};

type WeatherStatus = {
  bad: boolean;
  cold: boolean;
  snow: boolean;
  minTempF?: number;
  maxSnow?: number;
  reason?: string;
};

type LatLon = { lat: number; lon: number };

const geoCache = new Map<string, { value: LatLon; expiresAt: number }>();
const weatherCache = new Map<string, { value: WeatherStatus; expiresAt: number }>();

const GEO_TTL_MS = 6 * 60 * 60 * 1000;
const WEATHER_TTL_MS = 15 * 60 * 1000;

function cacheKey(lat: number, lon: number, hours: number, cold: number) {
  return `${lat.toFixed(4)}|${lon.toFixed(4)}|${hours}|${cold}`;
}

export function getWeatherConfig(profile: DealerProfileLike | null | undefined): WeatherConfig {
  const weather = profile?.weather ?? {};
  return {
    zip: weather.zip ?? profile?.address?.zip,
    latitude: weather.latitude,
    longitude: weather.longitude,
    coldThresholdF: weather.coldThresholdF ?? 50,
    forecastHours: weather.forecastHours ?? 48,
    pickupRadiusMiles: weather.pickupRadiusMiles ?? 25
  };
}

async function geocodeZip(zip: string): Promise<LatLon | null> {
  const key = zip.trim();
  if (!key) return null;
  const now = Date.now();
  const cached = geoCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    key
  )}&count=3&language=en&format=json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const best = results.find((r: any) => String(r?.country_code ?? "").toUpperCase() === "US") ?? results[0];
    if (!best) return null;
    const value = { lat: Number(best.latitude), lon: Number(best.longitude) };
    if (Number.isFinite(value.lat) && Number.isFinite(value.lon)) {
      geoCache.set(key, { value, expiresAt: now + GEO_TTL_MS });
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolveDealerLatLon(profile: DealerProfileLike | null | undefined): Promise<LatLon | null> {
  const cfg = getWeatherConfig(profile);
  if (Number.isFinite(cfg.latitude) && Number.isFinite(cfg.longitude)) {
    return { lat: Number(cfg.latitude), lon: Number(cfg.longitude) };
  }
  const zip = String(cfg.zip ?? "").trim();
  if (!zip) return null;
  return geocodeZip(zip);
}

export async function getDealerWeatherStatus(
  profile: DealerProfileLike | null | undefined
): Promise<WeatherStatus | null> {
  const cfg = getWeatherConfig(profile);
  const coords = await resolveDealerLatLon(profile);
  if (!coords) return null;
  const hours = Math.max(1, Math.min(72, Number(cfg.forecastHours ?? 48)));
  const coldThreshold = Number(cfg.coldThresholdF ?? 50);
  const key = cacheKey(coords.lat, coords.lon, hours, coldThreshold);
  const now = Date.now();
  const cached = weatherCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}` +
    `&longitude=${coords.lon}` +
    `&hourly=temperature_2m,snowfall,snow_depth` +
    `&forecast_days=3&temperature_unit=fahrenheit&timezone=auto`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const hourly = data?.hourly ?? {};
    const times: string[] = Array.isArray(hourly.time) ? hourly.time : [];
    const temps: number[] = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
    const snowfall: number[] = Array.isArray(hourly.snowfall) ? hourly.snowfall : [];
    const snowDepth: number[] = Array.isArray(hourly.snow_depth) ? hourly.snow_depth : [];
    if (!times.length) return null;
    const start = Date.now();
    const end = start + hours * 60 * 60 * 1000;
    let minTemp = Number.POSITIVE_INFINITY;
    let maxSnow = 0;
    for (let i = 0; i < times.length; i += 1) {
      const t = new Date(times[i]).getTime();
      if (Number.isNaN(t) || t < start || t > end) continue;
      const temp = Number(temps[i]);
      if (Number.isFinite(temp)) minTemp = Math.min(minTemp, temp);
      const snow = Math.max(Number(snowfall[i] ?? 0), Number(snowDepth[i] ?? 0));
      if (Number.isFinite(snow)) maxSnow = Math.max(maxSnow, snow);
    }
    const cold = Number.isFinite(minTemp) && minTemp < coldThreshold;
    const snow = maxSnow > 0;
    const bad = cold || snow;
    const status: WeatherStatus = {
      bad,
      cold,
      snow,
      minTempF: Number.isFinite(minTemp) ? minTemp : undefined,
      maxSnow: Number.isFinite(maxSnow) ? maxSnow : undefined,
      reason: bad ? (snow ? "snow" : "cold") : undefined
    };
    weatherCache.set(key, { value: status, expiresAt: now + WEATHER_TTL_MS });
    return status;
  } catch {
    return null;
  }
}
