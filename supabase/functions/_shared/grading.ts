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

export function matchEvent(events: any[], homeTeam: string, awayTeam: string) {
  const htW = normWords(homeTeam), atW = normWords(awayTeam);
  for (const ev of events) {
    const cs = ev.competitions?.[0]?.competitors || [];
    const hc = cs.find((c: any) => c.homeAway === "home");
    const ac = cs.find((c: any) => c.homeAway === "away");
    if (!hc || !ac) continue;
    const hn = normWords(hc.team?.displayName || hc.athlete?.displayName || "");
    const an = normWords(ac.team?.displayName || ac.athlete?.displayName || "");
    const htMatch = htW.some((w) => hn.includes(w)) || hn.some((w) => htW.includes(w));
    const atMatch = atW.some((w) => an.includes(w)) || an.some((w) => atW.includes(w));
    if (htMatch && atMatch) return ev;
  }
  return null;
}

export function scoreFor(events: any[], homeTeam: string, awayTeam: string) {
  const ev = matchEvent(events, homeTeam, awayTeam);
  if (!ev) return { found: false, done: false };
  if (!ev.status?.type?.completed) return { found: true, done: false };
  const comps = ev.competitions?.[0]?.competitors || [];
  const hc = comps.find((c: any) => c.homeAway === "home");
  const ac = comps.find((c: any) => c.homeAway === "away");
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

// Same 8-day look-ahead window fetchOdds() uses client-side, scoped to finding
// the one real event a specific home/away pair refers to.
export async function findEventAcrossDays(espnPath: string, homeTeam: string, awayTeam: string) {
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const today = new Date();
  const days = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(today); d.setDate(today.getDate() + i); return d;
  });
  for (const d of days) {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${fmt(d)}`);
    const j = await res.json().catch(() => ({ events: [] }));
    const ev = matchEvent(j.events || [], homeTeam, awayTeam);
    if (ev) return ev;
  }
  return null;
}

// Current scoreboard (undated call — "today's" slate), used for settlement the
// same way settlePending() fetches it client-side.
export async function fetchScoreboard(espnPath: string) {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard`);
  const j = await res.json();
  return j.events || [];
}

// A specific date-range scoreboard fetch, for Pick'em — a slate can span several
// days and a pick's game may already be a day or two in the past by settlement
// time, so (unlike fetchScoreboard's "today only" call) this needs an explicit
// window. Mirrors fetchEventsForRange() client-side.
export async function fetchEventsForRange(espnPath: string, startMs: number, endMs: number) {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${fmt(startMs)}-${fmt(endMs)}&limit=1000`);
  const j = await res.json().catch(() => ({ events: [] }));
  return j.events || [];
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

export async function fetchLeagueChampion(sportKey: string) {
  const src = CHAMPIONSHIP_SOURCES[sportKey];
  if (!src) return null;
  const range = src.range(FUTURES_SEASON);
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${src.espn}/scoreboard?dates=${range}&limit=1000`);
  const j = await res.json();
  const exclude = /pro bowl|all-star|all star/i;
  const postseason = (j.events || []).filter((e: any) => e.season?.type === 3 && !exclude.test(e.name || ""));
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

export function pickemMultiplier(correct: number, total: number): number {
  if (!total) return 0;
  const missed = total - correct;
  if (correct / total < 0.6) return 0;
  const perfect = Math.min(40, total * 3);
  const mult = missed === 0 ? perfect : perfect / Math.pow(2.2, missed);
  return Math.round(mult * 10) / 10;
}
