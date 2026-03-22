type GeoResult = {
  name: string;
  state?: string;
  lat: number;
  lon: number;
  distanceMiles: number;
};

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 3958.8 * c;
}

export async function resolveTownNearestDealer(
  town: string,
  dealerLat: number,
  dealerLon: number
): Promise<GeoResult | null> {
  const raw = String(town ?? "").trim();
  if (!raw) return null;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    raw
  )}&count=8&language=en&format=json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const filtered = results.filter(
      (r: any) => String(r?.country_code ?? "").toUpperCase() === "US"
    );
    const candidates = filtered.length ? filtered : results;
    if (!candidates.length) return null;
    let best: GeoResult | null = null;
    for (const r of candidates) {
      const lat = Number(r?.latitude);
      const lon = Number(r?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const distanceMiles = haversineMiles(dealerLat, dealerLon, lat, lon);
      const name = String(r?.name ?? raw).trim();
      const state = String(r?.admin1 ?? r?.admin2 ?? "").trim() || undefined;
      const candidate = { name, state, lat, lon, distanceMiles };
      if (!best || candidate.distanceMiles < best.distanceMiles) {
        best = candidate;
      }
    }
    return best;
  } catch {
    return null;
  }
}

export function formatTownLabel(name: string, state?: string | null): string {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) return "";
  const cleanState = String(state ?? "").trim();
  return cleanState ? `${cleanName}, ${cleanState}` : cleanName;
}
