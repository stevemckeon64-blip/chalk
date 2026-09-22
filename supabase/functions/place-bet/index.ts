// CHALK — place-bet Edge Function
//
// Server-side bet placement for the same first-wave scope as settle-bet: single
// (non-parlay, non-Pick'em) moneyline / spread / total bets, on sports with a
// plain ESPN scoreboard. Parlay / round-robin / Pick'em / props / futures /
// tennis / padel placement still goes through the old client path for now.
//
// Two things this closes that RLS alone can't:
//   1. The odds and line are never trusted from the client — this function
//      re-fetches the real current ESPN odds for the requested game/market
//      itself and uses THOSE, so a forged odds value can't inflate a payout
//      (settle-bet pays out based on whatever potential_payout was stored at
//      placement, so if placement doesn't validate odds, settlement paying
//      correctly doesn't matter).
//   2. The stake is deducted atomically against the real current balance,
//      re-read here, not trusted from whatever the client thinks its balance is.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ESPN_PATH: Record<string, string> = {
  americanfootball_nfl: "football/nfl",
  americanfootball_ncaaf: "football/college-football",
  basketball_nba: "basketball/nba",
  basketball_ncaab: "basketball/mens-college-basketball",
  baseball_mlb: "baseball/mlb",
  icehockey_nhl: "hockey/nhl",
  soccer_epl: "soccer/eng.1",
  soccer_spain_la_liga: "soccer/esp.1",
  soccer_uefa_champs_league: "soccer/uer.1",
  mma_mixed_martial_arts: "mma/ufc",
};

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}
function normWords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(" ").filter(Boolean);
}
function matchEvent(events: any[], homeTeam: string, awayTeam: string) {
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

function calcPayout(stake: number, odds: number): number {
  if (odds > 0) return stake + (stake * odds) / 100;
  return stake + (stake * 100) / Math.abs(odds);
}

// Real current odds for one game/market/selection, straight from ESPN — same
// fields fetchOdds() reads client-side (o.moneyline/.pointSpread/.total), just
// scoped to the one game this bet is actually on instead of a whole slate.
function extractMarket(ev: any, market: string, selection: string, homeName: string, awayName: string) {
  const o = ev.competitions?.[0]?.odds?.[0];
  if (!o) return null;
  if (market === "h2h") {
    const hML = parseInt(o.moneyline?.home?.close?.odds);
    const aML = parseInt(o.moneyline?.away?.close?.odds);
    if (isNaN(hML) || isNaN(aML)) return null;
    if (selection === homeName) return { odds: hML, line: null };
    if (selection === awayName) return { odds: aML, line: null };
    return null;
  }
  if (market === "spreads") {
    if (typeof o.spread !== "number") return null;
    const homePt = o.spread;
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

async function findEventAcrossDays(espnPath: string, homeTeam: string, awayTeam: string) {
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const today = new Date();
  // Same 7-day look-ahead window fetchOdds() uses client-side.
  const days = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(today); d.setDate(today.getDate() + i); return d;
  });
  for (const d of days) {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${fmt(d)}`);
    const json = await res.json().catch(() => ({ events: [] }));
    const ev = matchEvent(json.events || [], homeTeam, awayTeam);
    if (ev) return ev;
  }
  return null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const body = await req.json();
    const { sport, market, selection, home_team, away_team, game_id, stake } = body;

    if (!sport || !market || !selection || !home_team || !away_team || !stake) {
      return json({ error: "missing required fields" }, 400, origin);
    }
    if (typeof stake !== "number" || stake <= 0) {
      return json({ error: "invalid stake" }, 400, origin);
    }

    const espnPath = ESPN_PATH[sport];
    const supportedMarket = market === "h2h" || market === "spreads" || market === "totals";
    if (!espnPath || !supportedMarket) {
      return json(
        { error: "not_yet_supported", reason: "this bet type isn't server-placed yet" },
        501, origin,
      );
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) return json({ error: "not authenticated" }, 401, origin);
    const userId = userData.user.id;

    const ev = await findEventAcrossDays(espnPath, home_team, away_team);
    if (!ev) return json({ error: "game not found", reason: "no matching upcoming ESPN event" }, 404, origin);
    if (ev.status?.type?.state !== "pre") {
      return json({ error: "game already started", reason: "bets can only be placed on games that haven't started" }, 409, origin);
    }

    const comp = ev.competitions?.[0];
    const cs = comp?.competitors || [];
    const hc = cs.find((c: any) => c.homeAway === "home");
    const ac = cs.find((c: any) => c.homeAway === "away");
    const homeName = hc?.team?.displayName || hc?.athlete?.displayName || home_team;
    const awayName = ac?.team?.displayName || ac?.athlete?.displayName || away_team;

    const real = extractMarket(ev, market, selection, homeName, awayName);
    if (!real) return json({ error: "market not available", reason: "no real current odds for that selection" }, 404, origin);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const potentialPayout = Math.round(calcPayout(stake, real.odds) * 100) / 100;

    // Atomic stake deduction — same compare-and-swap pattern as applyBalanceDelta(),
    // re-read here so it's the real current balance, not whatever the client claims.
    let newBalance: number | null = null;
    for (let i = 0; i < 3 && newBalance === null; i++) {
      const { data: profile } = await admin.from("profiles").select("balance").eq("id", userId).single();
      if (!profile) return json({ error: "profile not found" }, 404, origin);
      if (profile.balance < stake) return json({ error: "insufficient balance" }, 402, origin);
      const attemptBal = Math.round((profile.balance - stake) * 100) / 100;
      const { data, error } = await admin.from("profiles").update({ balance: attemptBal })
        .eq("id", userId).eq("balance", profile.balance).select("id");
      if (!error && data && data.length) newBalance = attemptBal;
    }
    if (newBalance === null) return json({ error: "could not reserve stake, try again" }, 409, origin);

    const { data: bet, error: insertError } = await admin.from("bets").insert({
      user_id: userId, sport, game_id: game_id ?? ev.id,
      home_team: homeName, away_team: awayName,
      commence_time: ev.date, market, selection,
      line: real.line, odds: real.odds, stake, potential_payout: potentialPayout,
      status: "pending",
    }).select().single();

    if (insertError) {
      // Refund the reserved stake — the insert didn't happen, so the deduction must not stand.
      await admin.from("profiles").update({ balance: newBalance + stake }).eq("id", userId).eq("balance", newBalance);
      return json({ error: "could not place bet" }, 500, origin);
    }

    return json({ bet, new_balance: newBalance }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
