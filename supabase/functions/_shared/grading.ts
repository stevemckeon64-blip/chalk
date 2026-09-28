// CHALK — shared server-side grading logic
//
// Ported faithfully from index.html (matchEvent, gradeLegOutcome, scoreFor,
// calcPayout, calcParlayOdds, toDecimal, and the odds-extraction inside
// fetchOdds) so every Edge Function computes results identically to what the
// client would show, just somewhere the client can't lie to. Import this from
// every settlement/placement function rather than re-deriving any of it —
// keeps the real logic in exactly one place as more bet types get migrated.

export const ESPN_PATH: Record<string, string> = {
  americanfootball_nfl: "football/nfl",
  americanfootball_ncaaf: "football/college-football",
  basketball_nba: "basketball/nba",
  basketball_ncaab: "basketball/mens-college-basketball",
  baseball_mlb: "baseball/mlb",
  icehockey_nhl: "hockey/nhl",
  soccer_epl: "soccer/eng.1",
  soccer_spain_la_liga: "soccer/esp.1",
  soccer_uefa_champs_league: "soccer/uefa.champions",
  mma_mixed_martial_arts: "mma/ufc",
};

export const SOCCER_SPORTS = ["soccer_epl", "soccer_spain_la_liga", "soccer_uefa_champs_league"];

export function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
export function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function normWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(" ").filter(Boolean);
}

// Home/away sides of one competition. UFC fighters carry no homeAway field at all, so fall
// back to competitor order — the same convention the client's fetchOdds uses when it records
// a bet's home_team/away_team. Requiring homeAway meant every UFC bet failed to match.
export function compSides(comp: any) {
  const cs = comp?.competitors || [];
  return {
    hc: cs.find((c: any) => c.homeAway === "home") || cs[1],
    ac: cs.find((c: any) => c.homeAway === "away") || cs[0],
  };
}
// One pseudo-event per competition. A UFC card is a single ESPN event holding every fight
// (each with its own id/date/status); team sports are one competition per event.
export function flattenCompetitions(events: any[]) {
  return (events || []).flatMap((ev: any) => {
    const comps = ev.competitions || [];
    if (comps.length <= 1) return [ev];
    return comps.map((c: any) => ({ ...ev, id: c.id || ev.id, date: c.date || ev.date,
      status: c.status || ev.status, competitions: [c] }));
  });
}

export function namesMatch(ev: any, homeTeam: string, awayTeam: string) {
  const { hc, ac } = compSides(ev.competitions?.[0]);
  if (!hc || !ac) return false;
  const htW = normWords(homeTeam), atW = normWords(awayTeam);
  const hn = normWords(hc.team?.displayName || hc.athlete?.displayName || "");
  const an = normWords(ac.team?.displayName || ac.athlete?.displayName || "");
  const htMatch = htW.some((w) => hn.includes(w)) || hn.some((w) => htW.includes(w));
  const atMatch = atW.some((w) => an.includes(w)) || an.some((w) => atW.includes(w));
  return htMatch && atMatch;
}

export function matchEvent(events: any[], homeTeam: string, awayTeam: string) {
  return flattenCompetitions(events).find((ev: any) => namesMatch(ev, homeTeam, awayTeam)) || null;
}

// The exact game a bet was placed on. Stored ESPN id first — an MLB series is the same two
// teams on consecutive days, so a name match alone can grade the wrong game. Falls back to
// the name match whose start time is closest to the bet's own (old bets, pre-id UFC cards).
export function findGameEvent(events: any[], gameId: string | null | undefined, homeTeam: string, awayTeam: string, commenceMs: number) {
  const flat = flattenCompetitions(events);
  if (gameId) {
    const byId = flat.find((ev: any) => String(ev.id) === String(gameId));
    if (byId) return byId;
  }
  let best: any = null, bestGap = Infinity;
  for (const ev of flat) {
    if (!namesMatch(ev, homeTeam, awayTeam)) continue;
    const t = new Date(ev.date).getTime();
    const gap = isFinite(commenceMs) && isFinite(t) ? Math.abs(t - commenceMs) : Number.MAX_SAFE_INTEGER;
    if (gap < bestGap) { best = ev; bestGap = gap; }
  }
  return best;
}

// Postponed/canceled games come back as state "post" but never complete — treated as not
// found, so they void once the staleness window passes instead of sitting pending forever.
const DEAD_STATUSES = ["STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_CANCELLED"];

export function scoreForEvent(ev: any) {
  if (!ev || DEAD_STATUSES.includes(ev.status?.type?.name)) return { found: false, done: false };
  if (!ev.status?.type?.completed) return { found: true, done: false };
  const { hc, ac } = compSides(ev.competitions?.[0]);
  if (!hc || !ac) return { found: true, done: false };
  const hasNumericScore = hc.score != null && ac.score != null;
  if (hasNumericScore) {
    return { found: true, done: true, hs: parseInt(hc.score) || 0, as: parseInt(ac.score) || 0 };
  }
  if (typeof hc.winner === "boolean" || typeof ac.winner === "boolean") {
    return { found: true, done: true, hs: hc.winner ? 1 : 0, as: ac.winner ? 1 : 0 };
  }
  return { found: true, done: false };
}

export function gradeLegOutcome(
  market: string, selection: string, line: string | number | null,
  homeTeam: string, awayTeam: string, homeScore: number, awayScore: number,
  sportKey?: string,
): "won" | "lost" | "push" | "void" {
  if (market === "h2h") {
    if (homeScore === awayScore) {
      // Soccer offers a real, separately-priced Draw outcome — a tie means Home/Away
      // picks genuinely lost to a real alternative, not a push. Sports with no real
      // 3-way market still correctly push. See index.html's gradeLegOutcome for the
      // full note.
      if (sportKey && SOCCER_SPORTS.includes(sportKey)) return selection === "Draw" ? "won" : "lost";
      return "push";
    }
    const winner = homeScore > awayScore ? homeTeam : awayTeam;
    return winner === selection ? "won" : "lost";
  }
  if (market === "spreads" || market.startsWith("alt_sp_")) {
    const l = parseFloat(String(line)), isHome = selection === homeTeam;
    const margin = homeScore - awayScore;
    // The away side's line is already stored as the away team's own correctly-signed
    // spread (e.g. +7 when home is -7 favorite), not home's raw line, so it's added
    // directly here, not re-negated — re-negating it graded every away-side spread
    // pick backwards. See index.html's gradeLegOutcome for the same fix + full note.
    const covered = isHome ? margin + l : -margin + l;
    if (covered > 0) return "won";
    if (covered < 0) return "lost";
    return "push";
  }
  if (market === "totals" || market.startsWith("alt_tot_")) {
    const total = homeScore + awayScore, l = parseFloat(String(line));
    if (selection === "Over") return total > l ? "won" : total < l ? "lost" : "push";
    return total < l ? "won" : total > l ? "lost" : "push";
  }
  return "void";
}

export function toDecimal(american: number): number {
  return american >= 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}
export function calcPayout(stake: number, odds: number): number {
  if (odds > 0) return stake + (stake * odds) / 100;
  return stake + (stake * 100) / Math.abs(odds);
}
export function calcParlayOdds(legOdds: number[]): number {
  if (!legOdds.length) return 0;
  const dec = legOdds.reduce((acc, o) => acc * toDecimal(o), 1);
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}

// Real current odds for one game/market/selection, straight from ESPN — same
// fields fetchOdds() reads client-side (o.moneyline/.pointSpread/.total).
export function extractMarket(ev: any, market: string, selection: string, homeName: string, awayName: string) {
  const o = ev.competitions?.[0]?.odds?.[0];
  if (!o) return null;
  if (market === "h2h") {
    const hML = parseInt(o.moneyline?.home?.close?.odds);
    const aML = parseInt(o.moneyline?.away?.close?.odds);
    if (isNaN(hML) || isNaN(aML)) return null;
    if (selection === homeName) return { odds: hML, line: null as number | null };
    if (selection === awayName) return { odds: aML, line: null as number | null };
    if (selection === "Draw") {
      const dML = parseInt(o.moneyline?.draw?.close?.odds);
      if (!isNaN(dML)) return { odds: dML, line: null as number | null };
    }
    return null;
  }
  if (market === "spreads") {
    // o.spread is a convenience number some sports duplicate at the top level, but it's not
    // universal — soccer only carries the real line inside o.pointSpread.home.close.line (a
    // string). Reading that directly works for every sport that has a spread at all.
    const homePt = parseFloat(o.pointSpread?.home?.close?.line ?? o.spread);
    if (isNaN(homePt)) return null;
    const hOdds = parseInt(o.pointSpread?.home?.close?.odds ?? "-110");
    const aOdds = parseInt(o.pointSpread?.away?.close?.odds ?? "-110");
    if (selection === homeName) return { odds: isNaN(hOdds) ? -110 : hOdds, line: homePt };
    if (selection === awayName) return { odds: isNaN(aOdds) ? -110 : aOdds, line: -homePt };
    return null;
  }
  if (market === "totals") {
    if (o.overUnder == null) return null;
    const ovOdds = parseInt(o.total?.over?.close?.odds ?? "-110");
    const unOdds = parseInt(o.total?.under?.close?.odds ?? "-110");
    if (selection === "Over") return { odds: isNaN(ovOdds) ? -110 : ovOdds, line: o.overUnder };
    if (selection === "Under") return { odds: isNaN(unOdds) ? -110 : unOdds, line: o.overUnder };
    return null;
  }
  return null;
}

// ── ESPN access ──────────────────────────────────────────────────────────
// ESPN's CDN answers site.api.espn.com with 403 "Access Denied" for Supabase's servers (the
// browser app is unaffected). site.web.api.espn.com serves the identical API and isn't
// blocked. Every call goes through espnJson, which THROWS on any failure: a blocked or broken
// response must never read as "game not found" — settlement voids not-found games after 6h,
// and treating a 403 as an empty scoreboard once voided every pick in four Pick'em slates.
export const ESPN_SITE = "https://site.web.api.espn.com/apis/site/v2/sports";
export async function espnJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
  try { return await res.json(); } catch { throw new Error(`ESPN returned non-JSON for ${url}`); }
}

// ── Scoreboard fetching ──────────────────────────────────────────────────
// ESPN's scoreboard now rejects multi-day ranges (dates=YYYYMMDD-YYYYMMDD → 400) for every
// team sport, so every window is fetched one day at a time. limit=300: at limit>=999 ESPN
// silently truncates college football to 25 games.
const DAY_MS = 24 * 60 * 60 * 1000;
export const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

export async function fetchDay(espnPath: string, day: string, limit = 300) {
  const j = await espnJson(`${ESPN_SITE}/${espnPath}/scoreboard?dates=${day}&limit=${limit}`);
  return j.events || [];
}
export async function fetchDays(espnPath: string, days: string[], limit = 300) {
  const perDay = await Promise.all([...new Set(days)].map((d) => fetchDay(espnPath, d, limit)));
  const seen = new Set<string>(), out: any[] = [];
  for (const ev of perDay.flat()) if (!seen.has(ev.id)) { seen.add(ev.id); out.push(ev); }
  return out;
}
// ESPN files a game under its US Eastern date — the UTC date or the day before. The day
// after is padding for late-night cards.
export function daysAround(ms: number) {
  if (!isFinite(ms)) return [fmtDay(Date.now())];
  return [fmtDay(ms - DAY_MS), fmtDay(ms), fmtDay(ms + DAY_MS)];
}
// The scoreboard for the days a game was scheduled — not "today's" board, which a game
// from two days ago is no longer on (that used to void real results once 6h had passed).
export function fetchEventsAround(espnPath: string, commenceMs: number) {
  return fetchDays(espnPath, daysAround(commenceMs));
}

// Finds the real upcoming event a bet refers to (yesterday-UTC through the next week — the
// same window fetchOdds() lists). With a gameId, only that exact game counts as found, so a
// bet on game 3 of a series is never priced off game 1.
export async function findEventAcrossDays(espnPath: string, homeTeam: string, awayTeam: string, gameId?: string | null) {
  const now = Date.now();
  let upcoming: any = null, anyMatch: any = null;
  for (const batch of [[-1, 0, 1], [2, 3, 4, 5, 6, 7]]) {
    const events = await fetchDays(espnPath, batch.map((i) => fmtDay(now + i * DAY_MS)));
    const flat = flattenCompetitions(events).sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
    if (gameId) {
      const byId = flat.find((ev: any) => String(ev.id) === String(gameId));
      if (byId) return byId;
    }
    // Without an id match, the soonest game that hasn't started beats one already underway.
    const named = flat.filter((ev: any) => namesMatch(ev, homeTeam, awayTeam));
    upcoming = upcoming || named.find((ev: any) => ev.status?.type?.state === "pre") || null;
    anyMatch = anyMatch || named[0] || null;
    if (upcoming && !gameId) return upcoming;
  }
  return upcoming || anyMatch;
}

// Every day in a window, for Pick'em — a slate can span several days (capped at three
// weeks). Mirrors fetchEventsForRange() client-side.
export function fetchEventsForRange(espnPath: string, startMs: number, endMs: number) {
  const days: string[] = [];
  for (let t = startMs; t <= endMs + DAY_MS && days.length < 21; t += DAY_MS) days.push(fmtDay(t));
  return fetchDays(espnPath, days);
}

// ── Cash-out (priced from ESPN's real live win probability) ──────────────
// Only moneyline bets in leagues where ESPN publishes an in-game win probability. The offer
// is the stake scaled by how the pick's win chance has moved since kickoff, on ESPN's own
// model (win% now ÷ win% at kickoff), less a 5% margin. Measuring the move, not the raw
// probability, matters: wherever ESPN's model rates a team above the betting odds, paying
// payout × win% would let anyone bet that side and cash out at kickoff for a sure profit.
// This way cashing out at kickoff returns ~95% of the stake, and the offer tracks the game.
export const CASHOUT_SPORTS = ["americanfootball_nfl", "americanfootball_ncaaf", "basketball_nba", "basketball_ncaab"];
export const CASHOUT_MARGIN = 0.95;
const UNAVAILABLE = (reason: string) => ({ error: "unavailable" as const, reason });

export async function cashOutQuote(bet: any) {
  if (bet.market !== "h2h" || !CASHOUT_SPORTS.includes(bet.sport)) {
    return UNAVAILABLE("Cash-out is only offered on moneyline bets in the NFL, college football, the NBA, and college basketball, where there's a real live win probability to price it from.");
  }
  if (!/^\d+$/.test(String(bet.game_id || ""))) return UNAVAILABLE("This bet isn't linked to a live ESPN game.");
  let j: any;
  try { j = await espnJson(`${ESPN_SITE}/${ESPN_PATH[bet.sport]}/summary?event=${bet.game_id}`); }
  catch { return UNAVAILABLE("Couldn't reach live game data. Try again in a moment."); }
  const comp = j?.header?.competitions?.[0];
  if (!comp || !namesMatch({ competitions: [comp] }, bet.home_team, bet.away_team)) return UNAVAILABLE("Couldn't find this game's live data.");
  if (comp.status?.type?.state !== "in") return UNAVAILABLE("Cash-out opens once the game is live.");
  const wp = j.winprobability || [];
  const first = wp[0], last = wp[wp.length - 1];
  if (!first || !last || typeof first.homeWinPercentage !== "number" || typeof last.homeWinPercentage !== "number") {
    return UNAVAILABLE("ESPN hasn't posted a live win probability for this game yet.");
  }
  const side = (pt: any) => bet.selection === bet.home_team ? pt.homeWinPercentage
    : bet.selection === bet.away_team ? 1 - pt.homeWinPercentage - (pt.tiePercentage || 0) : NaN;
  const pNow = side(last), pKick = side(first);
  if (!isFinite(pNow) || !isFinite(pKick) || pKick < 0.02) return UNAVAILABLE("No usable live win probability for this pick.");
  const value = Math.floor(Math.min(bet.stake * (pNow / pKick), bet.potential_payout) * CASHOUT_MARGIN * 100) / 100;
  if (value < 0.01) return UNAVAILABLE("This bet has no cash-out value left.");
  return { value, prob: pNow };
}

// ── Futures (real season-long outcomes — different ESPN domain entirely) ──
export const FUTURES_CONFIG = [
  { sport:'football', league:'nfl', marketId:1561, title:'🏈 Super Bowl Winner', sportKey:'americanfootball_nfl', type:'championship' },
  { sport:'football', league:'nfl', marketId:1208, title:'🏈 NFL MVP', sportKey:'americanfootball_nfl', type:'award', awardId:477 },
  { sport:'football', league:'nfl', marketId:1210, title:'🏈 NFL Defensive Player of the Year', sportKey:'americanfootball_nfl', type:'award', awardId:479 },
  { sport:'football', league:'college-football', marketId:2758, title:'🏈 College Football Playoff Champion', sportKey:'americanfootball_ncaaf', type:'championship' },
  { sport:'football', league:'college-football', marketId:15234, title:'🏈 Heisman Trophy', sportKey:'americanfootball_ncaaf', type:'award', awardId:9 },
  { sport:'basketball', league:'nba', marketId:2564, title:'🏀 NBA Champion', sportKey:'basketball_nba', type:'championship' },
  { sport:'basketball', league:'nba', marketId:2581, title:'🏀 NBA MVP', sportKey:'basketball_nba', type:'award', awardId:33 },
  { sport:'basketball', league:'mens-college-basketball', marketId:232692, title:'🏀 March Madness Champion', sportKey:'basketball_ncaab', type:'championship' },
  { sport:'baseball', league:'mlb', marketId:2761, title:'⚾ World Series Winner', sportKey:'baseball_mlb', type:'championship' },
  { sport:'hockey', league:'nhl', marketId:2118, title:'🏒 Stanley Cup Winner', sportKey:'icehockey_nhl', type:'championship' },
  { sport:'hockey', league:'nhl', marketId:14495, title:'🏒 Hart Trophy (MVP)', sportKey:'icehockey_nhl', type:'award', awardId:112 },
] as const;
export const FUTURES_SEASON = 2026;
export const CHAMPIONSHIP_SOURCES: Record<string, { espn: string; range: (y: number) => string }> = {
  americanfootball_nfl:   { espn:'football/nfl', range: y => `${y}1101-${y+1}0301` },
  americanfootball_ncaaf: { espn:'football/college-football', range: y => `${y}1101-${y+1}0201` },
  basketball_nba:         { espn:'basketball/nba', range: y => `${y+1}0301-${y+1}0715` },
  basketball_ncaab:       { espn:'basketball/mens-college-basketball', range: y => `${y+1}0201-${y+1}0430` },
  baseball_mlb:           { espn:'baseball/mlb', range: y => `${y}0801-${y}1201` },
  icehockey_nhl:          { espn:'hockey/nhl', range: y => `${y+1}0301-${y+1}0715` },
};

export async function resolveRefInfo(url: string) {
  try {
    const res = await fetch(url);
    const j = await res.json();
    return { name: j.displayName || j.fullName || null, logo: j.logos?.[0]?.href || null };
  } catch { return null; }
}
export async function resolveRefName(url: string) { return (await resolveRefInfo(url))?.name || null; }

// Real current futures odds for one market+selection — same field/sort logic as
// fetchFuturesMarket() client-side, scoped to just the one selection being bet on.
export async function fetchFuturesOdds(cfg: typeof FUTURES_CONFIG[number], selection: string) {
  const res = await fetch(`https://sports.core.api.espn.com/v2/sports/${cfg.sport}/leagues/${cfg.league}/seasons/${FUTURES_SEASON}/futures/${cfg.marketId}?lang=en&region=us`);
  const j = await res.json();
  const books = j.futures?.[0]?.books || [];
  for (const b of books) {
    const ref = b.athlete?.$ref || b.team?.$ref;
    const odds = parseInt(b.value ?? b.moneyLine ?? "");
    if (!ref || isNaN(odds)) continue;
    const info = await resolveRefInfo(ref);
    if (info?.name === selection) return odds;
  }
  return null;
}

// "YYYYMMDD-YYYYMMDD" → every YYYYMM it touches. ESPN still accepts whole-month queries,
// just not day ranges.
export function monthsInRange(range: string) {
  const [a, b] = range.split("-");
  let y = +a.slice(0, 4), m = +a.slice(4, 6);
  const ey = +b.slice(0, 4), em = +b.slice(4, 6), out: string[] = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

export async function fetchLeagueChampion(sportKey: string) {
  const src = CHAMPIONSHIP_SOURCES[sportKey];
  if (!src) return null;
  // limit=500: a regular-season MLB month runs ~420 games.
  const events = await fetchDays(src.espn, monthsInRange(src.range(FUTURES_SEASON)), 500);
  const exclude = /pro bowl|all-star|all star/i;
  const postseason = events.filter((e: any) => e.season?.type === 3 && !exclude.test(e.name || ""));
  const unfinished = postseason.some((e: any) => !e.status?.type?.completed);
  const finished = postseason.filter((e: any) => e.status?.type?.completed);
  if (unfinished || !finished.length) return null;
  finished.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const winner = (finished[0].competitions?.[0]?.competitors || []).find((c: any) => c.winner === true);
  return winner?.team?.displayName || null;
}

export async function fetchAwardWinner(cfg: typeof FUTURES_CONFIG[number]) {
  const res = await fetch(`https://sports.core.api.espn.com/v2/sports/${cfg.sport}/leagues/${cfg.league}/seasons/${FUTURES_SEASON}/awards/${cfg.awardId}?lang=en&region=us`);
  if (!res.ok) return null;
  const j = await res.json();
  const ref = j.winners?.[0]?.athlete?.$ref;
  return ref ? await resolveRefName(ref) : null;
}

// ── Tennis (ATP) — rank-derived odds, no real betting market from ESPN ────
// Ported from fetchTennisOdds()/fetchAtpRankings()/fetchTennisPseudoEvents() client-side.
export function probToAmericanOdds(p: number): number {
  if (p >= 50) return Math.round(-(p / (100 - p)) * 100);
  return Math.round(((100 - p) / p) * 100);
}
export async function fetchAtpRankings(): Promise<Record<string, number>> {
  const j = await espnJson(`${ESPN_SITE}/tennis/atp/rankings`);
  const ranks = j.rankings?.[0]?.ranks || [];
  const map: Record<string, number> = {};
  for (const r of ranks) if (r.athlete?.id && r.current) map[r.athlete.id] = r.current;
  return map;
}
// The player's ESPN id lives on the competitor object itself (competitor.id), not nested
// under competitor.athlete.id — see the Wave-tagged fix note in index.html's fetchTennisOdds.
export function rankOddsFor(rankMap: Record<string, number>, homeId: string, awayId: string) {
  const hr = rankMap[homeId], ar = rankMap[awayId];
  if (!hr || !ar) return null;
  const pHome = Math.round((ar / (hr + ar)) * 100);
  const clamped = Math.min(95, Math.max(5, pHome));
  return { homeOdds: probToAmericanOdds(clamped), awayOdds: probToAmericanOdds(100 - clamped) };
}
export async function findTennisMatch(homeTeam: string, awayTeam: string, daysAhead = 10) {
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const today = new Date();
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    const j = await espnJson(`${ESPN_SITE}/tennis/atp/scoreboard?dates=${fmtDate(d)}`);
    for (const tev of (j.events || [])) {
      const grouping = (tev.groupings || []).find((g: any) => g.grouping?.slug === "mens-singles") || tev.groupings?.[0];
      for (const comp of (grouping?.competitions || [])) {
        const cs = comp.competitors || [];
        const home = cs.find((c: any) => c.homeAway === "home") || cs[1];
        const away = cs.find((c: any) => c.homeAway === "away") || cs[0];
        const hn = home?.athlete?.displayName, an = away?.athlete?.displayName;
        if (hn === homeTeam && an === awayTeam) return { comp, home, away };
      }
    }
  }
  return null;
}
// Settlement: scans the last few days of real results for a completed match with this
// exact matchup, same window fetchTennisPseudoEvents() uses client-side.
export async function findCompletedTennisMatch(homeTeam: string, awayTeam: string, daysBack = 4) {
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const today = new Date();
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const j = await espnJson(`${ESPN_SITE}/tennis/atp/scoreboard?dates=${fmtDate(d)}`);
    for (const tev of (j.events || [])) {
      const grouping = (tev.groupings || []).find((g: any) => g.grouping?.slug === "mens-singles") || tev.groupings?.[0];
      for (const comp of (grouping?.competitions || [])) {
        if (!comp.status?.type?.completed) continue;
        const cs = comp.competitors || [];
        const home = cs.find((c: any) => c.homeAway === "home") || cs[1];
        const away = cs.find((c: any) => c.homeAway === "away") || cs[0];
        if (home?.athlete?.displayName === homeTeam && away?.athlete?.displayName === awayTeam) {
          return { winnerIsHome: home.winner === true };
        }
      }
    }
  }
  return null;
}

export function pickemMultiplier(correct: number, total: number): number {
  if (!total) return 0;
  const missed = total - correct;
  if (correct / total < 0.6) return 0;
  const perfect = Math.min(40, total * 3);
  const mult = missed === 0 ? perfect : perfect / Math.pow(2.2, missed);
  return Math.round(mult * 10) / 10;
}
