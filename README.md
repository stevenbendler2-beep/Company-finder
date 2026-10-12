# Company Finder

Type a business type, city and state, and get up to 100 local companies with websites, phones, Google review counts and a size rating. Results can be downloaded as Excel or CSV.

**Sources:** Google Places API (New) Text Search, capped to stay inside Google's free monthly allowance, plus OpenStreetMap (free).

## Settings (Render → Environment)
| Variable | What it does |
|---|---|
| `GOOGLE_PLACES_KEY` | Google Maps Platform API key (Places API (New) enabled) |
| `ACCESS_CODE` | Shared team code people enter once on the page |
| `DAILY_GOOGLE_CAP` | Max Google requests per day (default 33 ≈ 1,000/month free allowance) |

Repeat searches within 7 days come from cache and cost nothing. Size rating = Google review volume (Strong 100+, Likely 30–99, Verify <30); it is an estimate, not reported revenue.
