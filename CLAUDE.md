# CHALK — Claude Code Instructions

## What it is
CHALK is a social sports betting web app — a single-file HTML app (`index.html`, ~3,600 lines) deployed via Netlify drag-and-drop. Users sign up, get a $5,000 virtual balance, place bets on real live games, and compete on a leaderboard. No real money involved.

**Current file:** `/Users/stevemckeon64/Desktop/chalk/index.html`

---

## Architecture
Single self-contained HTML file. All CSS, JS, and HTML in `index.html`. No build step, no bundler, no framework. Deploy = drag file onto Netlify.

### Views (tab-based SPA)
| View | Function |
|---|---|
| `games` | Browse live/upcoming games, pick bets, add to bet slip |
| `bets` | My Bets history — pending, won, lost, cashed out |
| `leaderboard` | Global or room-specific rankings by P&L |
| `profile` | Balance, betting stats, loyalty tier, settings |

Navigation: `showView(view)` — top nav tabs + `currentView` state variable.

### Sports supported
NFL, NCAAF, NBA, NCAAB, NCAAW, MLB, NHL, EPL, La Liga, Bundesliga, UCL, Serie A, MLS, UFC/MMA, ATP Tennis, PGA Golf, Padel Premier Tour, Futures markets.

---

## Key Config (top of `<script>`)

```js
const SUPABASE_URL  = 'https://pdbhpkzwbouvtveckxba.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_uPhXyeh1_7dX1-KRpi2lgg_Fhqcz--Y';  // anon/publishable key — safe to commit
const PPL_API_KEY   = 'nkY3SZQkXOCovlQJb5CG67BHbAsURFWFUFweMEnN109c98af'; // Premier Padel API
const PPL_BASE      = 'https://padelapi.org/api';
const STARTING_BALANCE = 5000;   // virtual dollars
const ODDS_TTL      = 15 * 60 * 1000;  // 15-min odds cache
const PPL_TTL       = 30 * 60 * 1000;  // 30-min padel cache
```

---

## Data Sources

### Odds — ESPN (free, no key, no limits)
`fetchOdds(sport)` hits `https://site.api.espn.com/apis/site/v2/sports/{sport}/scoreboard` and parses game data. No API key required. Cached in `localStorage` per sport with 15-min TTL.

- Falls back to `getMock(sport)` if ESPN returns no data (off-season, etc.)
- `getMarket(game, key)` extracts moneyline/spread/totals from ESPN odds

### Premier Padel (PPL)
`fetchPPL()` hits `PPL_BASE` with `PPL_API_KEY`. Returns live padel match data converted to the same game card format as ESPN sports.

### Player Props
`generatePlayerProps(g)` — simulated from `PLAYER_FIRSTS`/`PLAYER_LASTS` arrays + `PROP_SPORTS` config. Not real API data — procedurally generated for each game.

### Futures
`FUTURES_MARKETS` array — hardcoded odds for Super Bowl, NBA Finals, World Series, Stanley Cup, etc. Static data, manually updated.

---

## Database — Supabase

### Tables
| Table | Purpose |
|---|---|
| `profiles` | `id` (= auth user id), `username`, `balance`, `total_wagered` |
| `bets` | `user_id`, `sport`, `market`, `selection`, `odds`, `stake`, `potential_payout`, `status` (pending/won/lost/cashedout), `commence_time`, `settled_at`, `legs` (JSONB for parlays), `is_parlay` |
| `rooms` | `id`, `name`, `code`, `created_by` |
| `room_members` | `room_id`, `user_id` |

### Auth
Supabase email/password auth. `sb.auth.signInWithPassword()` / `sb.auth.signUp()`. Session persisted automatically by Supabase client.

### Key DB patterns
```js
// Place a bet
await sb.from('bets').insert({ user_id, sport, market, selection, odds, stake, potential_payout, commence_time, is_parlay, legs })

// Update balance
await sb.from('profiles').update({ balance: newBal }).eq('id', user.id)

// Load my bets
await sb.from('bets').select('*').eq('user_id', user.id).order('created_at', { ascending: false })

// Leaderboard
await sb.from('profiles').select('*').order('balance', { ascending: false }).limit(50)
```

---

## Core Game Logic

### Odds math
```js
function toDecimal(american)   // converts American → decimal odds
function calcParlayOdds(legs)  // multiplies decimal odds across parlay legs
function calcPayout(stake, odds) // returns potential payout
```

### Bet slip
- State: `slip` array of leg objects `{ gameId, market, selection, odds, team, opponent, commence_time }`
- `legKey(leg)` — dedupes by `gameId_market_selection`
- Single bets and parlays both use the same slip; parlay toggle shows combined odds

### Bet settlement
`settlePendingBets()` — runs on login and periodically. Checks bets where `commence_time < now` against current ESPN scores. Auto-settles won/lost; updates balance in Supabase.

### Cash out
`doCashOut(betId, currentValue)` — settles a pending bet early at current market value.

---

## Rooms (private leaderboards)
- Users can create a room (gets a 6-char code) or join via code
- `currentRoom` state — null = global leaderboard, set = filtered to room members
- `myRooms` array loaded on login via `room_members` join

---

## Loyalty Tiers
`TIERS` array keyed by `total_wagered`. Higher wagered = higher tier. Shown on profile. `getTier(wagered)` and `nextTier(wagered)` helpers.

---

## UI Patterns
- **Live ticker** — `loadLiveTicker(sport)` scrolls current scores across top
- **Odds movement arrows** — `oddsMovement(gameId, market, selIdx)` shows ▲▼ vs cached odds
- **Confetti** — `launchConfetti()` on winning bets
- **Balance animation** — `animateBalance(targetVal)` counts up/down
- **Toast** — `showToast(msg, type)` — success/error/info
- **Odds format toggle** — American / Decimal / Fractional, persisted in `localStorage('chalk_odds_fmt')`

---

## Deployment
Drag `index.html` onto Netlify. No build step. Site is public.

---

## Known issues / pending work
- Player props are simulated, not real API data
- Futures odds are hardcoded and need manual updates each season
- Bet settlement logic uses ESPN scores which may lag for some sports
- No push notifications for settled bets — users must open app

---

## Steve's preferences
- Single-file only — no build tools, no frameworks, keep it all in `index.html`
- Supabase anon key is intentionally public (RLS protects the data)
- Don't add real-money functionality — this is a virtual/social betting app
