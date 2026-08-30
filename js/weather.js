/*
 * weather.js
 * ----------
 * Talks to Open-Meteo (https://open-meteo.com) — a free weather API that
 * needs no API key and no signup, which is why we picked it for a
 * hackathon demo. We pull current wind/gust/precipitation for whichever
 * coordinates this deployment is configured for (see ISLAND in data.js —
 * Port Vila, Vanuatu's capital, for this demo), and turn that into one
 * of our four storm severity levels (calm / watch / warning / severe).
 *
 * Because a venue's wifi can't be relied on mid-demo, every place that
 * calls fetchLiveWeather() is expected to fall back gracefully to the
 * manual "Simulate Storm" control in app.js if the request fails.
 */

async function fetchLiveWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${ISLAND.lat}&longitude=${ISLAND.lon}` +
    `&current=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,weather_code,cloud_cover` +
    `&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch`;

  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`Open-Meteo request failed: ${response.status}`);

  const data = await response.json();
  const current = data.current;

  return {
    source: "live",
    tempF: current.temperature_2m,
    windMph: current.wind_speed_10m,
    gustMph: current.wind_gusts_10m,
    precipIn: current.precipitation,
    weatherCode: current.weather_code,
    cloudCoverPct: current.cloud_cover,
    description: describeWeatherCode(current.weather_code),
    severity: deriveSeverityFromWind(current.wind_gusts_10m)
  };
}

/**
 * Pulls Open-Meteo's hourly forecast (not just the current reading) and
 * turns it into an hour-by-hour outlook for the next `hoursAhead` hours —
 * the projected severity and cloud cover at each point. This is what lets
 * the console look ahead ("critical in ~9h if the storm holds this
 * track") instead of only reacting to the current instant.
 */
async function fetchHourlyOutlook(hoursAhead = 24) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${ISLAND.lat}&longitude=${ISLAND.lon}` +
    `&hourly=wind_gusts_10m,cloud_cover&wind_speed_unit=mph&forecast_days=2`;

  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`Open-Meteo hourly request failed: ${response.status}`);

  const data = await response.json();
  const { time, wind_gusts_10m: gusts, cloud_cover: clouds } = data.hourly;
  const now = Date.now();

  return time
    .map((isoHour, i) => ({
      hoursFromNow: Math.round((new Date(isoHour).getTime() - now) / 3_600_000),
      gustMph: gusts[i],
      cloudCoverPct: clouds[i]
    }))
    .filter(h => h.hoursFromNow >= 0 && h.hoursFromNow <= hoursAhead)
    .map(h => ({ ...h, severity: deriveSeverityFromWind(h.gustMph) }));
}

/**
 * Our rule for turning real wind data into a severity level. These
 * thresholds are simplified from the real Australian/Vanuatu Meteorology
 * tropical cyclone category scale so they're easy to state out loud to a
 * judge:
 *   >= 74 mph gusts -> cyclone-force        -> "severe"
 *   >= 39 mph gusts -> tropical-storm-force -> "warning"
 *   >= 25 mph gusts -> strong/gusty         -> "watch"
 *   otherwise                               -> "calm"
 */
function deriveSeverityFromWind(gustMph) {
  if (gustMph >= 74) return "severe";
  if (gustMph >= 39) return "warning";
  if (gustMph >= 25) return "watch";
  return "calm";
}

// Minimal subset of the WMO weather codes Open-Meteo returns, just enough
// for a human-readable label in the UI.
const WEATHER_CODE_LABELS = {
  0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Rain", 65: "Heavy rain",
  71: "Slight snow", 73: "Snow", 75: "Heavy snow",
  80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail"
};

function describeWeatherCode(code) {
  return WEATHER_CODE_LABELS[code] || "Conditions unavailable";
}

/**
 * Manual fallback / demo trigger. Builds a synthetic weather reading for
 * each severity level so the "Simulate Storm" button works identically
 * whether or not the venue has working wifi.
 */
function simulatedWeatherFor(severity) {
  const presets = {
    calm:    { tempF: 84, windMph: 9,  gustMph: 14, precipIn: 0.0, cloudCoverPct: 10, description: "Clear sky" },
    watch:   { tempF: 81, windMph: 22, gustMph: 30, precipIn: 0.3, cloudCoverPct: 55, description: "Rain showers, tropical cyclone watch issued" },
    warning: { tempF: 77, windMph: 38, gustMph: 52, precipIn: 1.1, cloudCoverPct: 80, description: "Tropical cyclone warning in effect" },
    severe:  { tempF: 73, windMph: 65, gustMph: 88, precipIn: 3.4, cloudCoverPct: 95, description: "Cyclone-force winds — severe storm" }
  };
  return { source: "simulated", severity, ...presets[severity] };
}
