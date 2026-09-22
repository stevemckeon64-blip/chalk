// CHALK — settle-bet Edge Function
//
// Server-side re-verification for the most-common bet shapes: single (non-parlay,
// non-Pick'em) moneyline / spread / total bets, on the sports with a plain ESPN
// scoreboard (everything except tennis, futures, and padel — those still settle
// client-side for now; see the CHALK vault note for the follow-up waves).
//
// This is the piece that actually closes the devtools-exploit hole: the client
// can request settlement, but the OUTCOME and PAYOUT are derived here, from a
// real ESPN score this function fetches itself — never trusted from the request.
//
// Ported faithfully from index.html's matchEvent() / gradeLegOutcome() / scoreFor()
// / calcPayout() so results match exactly what the client would have computed,
// just computed somewhere the client can't lie to.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Same SPORTS -> ESPN path map as index.html, restricted to the sports this first
// wave actually supports (plain team-vs-team scoreboard, no special fetch shape).
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

function normWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
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

function scoreFor(events: any[], homeTeam: string, awayTeam: string) {
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

function gradeLegOutcome(
  market: string, selection: string, line: string | number | null,
  homeTeam: string, awayTeam: string, homeScore: number, awayScore: number,
): "won" | "lost" | "push" | "void" {
  if (market === "h2h") {
    if (homeScore === awayScore) return "push";
    const winner = homeScore > awayScore ? homeTeam : awayTeam;
    return winner === selection ? "won" : "lost";
  }
  if (market === "spreads" || market.startsWith("alt_sp_")) {
    const l = parseFloat(String(line)), isHome = selection === homeTeam;
    const margin = homeScore - awayScore;
    const covered = isHome ? margin + l : -margin + -l;
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

async function fetchScoreboard(espnPath: string) {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard`);
  const json = await res.json();
  return json.events || [];
}

// Same optimistic-concurrency pattern as applyBalanceDelta() client-side, just
// running with the service-role key so it's trustworthy.
async function creditBalance(admin: any, userId: string, delta: number, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const { data: profile } = await admin.from("profiles").select("balance").eq("id", userId).single();
    if (!profile) return null;
    const newBal = Math.round((profile.balance + delta) * 100) / 100;
    const { data, error } = await admin
      .from("profiles")
      .update({ balance: newBal })
      .eq("id", userId)
      .eq("balance", profile.balance)
      .select("id");
    if (!error && data && data.length) return newBal;
  }
  return null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const { bet_id } = await req.json();
    if (!bet_id) {
      return new Response(JSON.stringify({ error: "bet_id required" }), {
        status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    // Identify the caller from their own JWT — a user may only ask us to settle
    // their own bet, never someone else's (even though the result is independently
    // re-derived either way, this keeps the function from being usable to snoop).
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) {
      return new Response(JSON.stringify({ error: "not authenticated" }), {
        status: 401, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    const callerId = userData.user.id;

    // Service-role client for the actual reads/writes — bypasses RLS deliberately,
    // since this function IS the trusted server RLS alone can't provide.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: bet, error: betError } = await admin.from("bets").select("*").eq("id", bet_id).single();
    if (betError || !bet) {
      return new Response(JSON.stringify({ error: "bet not found" }), {
        status: 404, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    if (bet.user_id !== callerId) {
      return new Response(JSON.stringify({ error: "not your bet" }), {
        status: 403, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    if (bet.status !== "pending") {
      return new Response(JSON.stringify({ status: bet.status, already_settled: true }), {
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const espnPath = ESPN_PATH[bet.sport];
    const supportedMarket =
      bet.market === "h2h" || bet.market === "spreads" || bet.market === "totals" ||
      bet.market.startsWith("alt_sp_") || bet.market.startsWith("alt_tot_");
    if (!espnPath || !supportedMarket) {
      // Parlay / Pick'em / futures / props / tennis / padel — not ported to this
      // function yet. Tell the client plainly so it knows to keep using its own
      // (still client-trusted, for now) path for these rather than silently no-op.
      return new Response(
        JSON.stringify({ error: "not_yet_supported", reason: "this bet type isn't server-settled yet" }),
        { status: 501, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    const events = await fetchScoreboard(espnPath);
    const info = scoreFor(events, bet.home_team, bet.away_team);

    if (!info.done) {
      return new Response(JSON.stringify({ status: "pending", reason: "game not final yet" }), {
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const result = gradeLegOutcome(bet.market, bet.selection, bet.line, bet.home_team, bet.away_team, info.hs!, info.as!);
    const payout = result === "won" ? bet.potential_payout : result === "push" ? bet.stake : 0;

    await admin.from("bets").update({ status: result, settled_at: new Date().toISOString() }).eq("id", bet.id);
    if (payout > 0) await creditBalance(admin, bet.user_id, payout);

    return new Response(JSON.stringify({ status: result, payout }), {
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }
});
