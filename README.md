# Company Finder

Type a business type, city and state → up to 100 local companies with websites, phones, Google review counts and a size rating. Download as Excel or CSV. Team code required.

## Free data sources (each turns on when its key is set in Render → Environment)
| Source | Setting | Free allowance | Notes |
|---|---|---|---|
| Google Places API (New) | `GOOGLE_PLACES_KEY` | 1,000 requests/month (`DAILY_GOOGLE_CAP`, default 33/day) | Reviews + ratings → size rating. Card on file; set the per-day quota in Google Cloud too. |
| HERE Discover | `HERE_API_KEY` | 5,000/month (`DAILY_HERE_CAP`, default 160/day) | 100 results per request, phones + websites. |
| TomTom POI Search | `TOMTOM_API_KEY` | 2,500/month, no card (`DAILY_TOMTOM_CAP`, default 80/day) | 100 results per request, phones + websites. |
| OpenStreetMap (Overpass) | — | free | Best effort; public servers are often busy. |

City lookup: Open-Meteo geocoding (free, no key), Nominatim fallback.

**System check:** the "Run system check" button (or `/api/selftest?code=…`) tests every source with a tiny free request and explains any problem in plain English.

Repeat searches within 7 days come from cache and use no lookups. Size rating = Google review volume (Strong 100+, Likely 30–99, Verify <30) — an estimate, not reported revenue.
