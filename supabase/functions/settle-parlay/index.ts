// CHALK — settle-parlay Edge Function
//
// Handles both real parlays and Round Robin combos — a Round Robin combo is
// stored as an ordinary 2-leg parlay row (selection.rr === true, display-only),
// so one settlement path covers both. Every leg's real result is re-derived
// independently; if any leg falls outside the supported sports/markets, the
// whole bet is declined (501) so it falls back to the existing client path
// rather than partially trusting one leg and not another.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { ESPN_PATH, scoreForEvent, findGameEvent, gradeLegOutcome, calcPayout, calcParlayOdds, daysAround, fetchDays, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const STALE_MS = 6 * 60 * 60 * 1000; // matches settlePending()'s client-side staleness window

async function creditBalance(admin: any, userId: string, delta: number, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const { data: profile } = await admin.from("profiles").select("balance").eq("id", userId).single();
    if (!profile) return null;
    const newBal = Math.round((profile.balance + delta) * 100) / 100;
    const { data, error } = await admin.from("profiles").update({ balance: newBal })
      .eq("id", userId).eq("balance", profile.balance).select("id");
    if (!error && data && data.length) return newBal;
  }
  return null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const { bet_id } = await req.json();
    if (!bet_id) return json({ error: "bet_id required" }, 400, origin);

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) return json({ error: "not authenticated" }, 401, origin);
    const callerId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: bet, error: betError } = await admin.from("bets").select("*").eq("id", bet_id).single();
    if (betError || !bet) return json({ error: "bet not found" }, 404, origin);
    if (bet.user_id !== callerId) return json({ error: "not your bet" }, 403, origin);
    if (bet.status !== "pending") return json({ status: bet.status, already_settled: true }, 200, origin);
    if (bet.market !== "parlay") return json({ error: "not_yet_supported" }, 501, origin);

    let parsed: any;
    try { parsed = JSON.parse(bet.selection); } catch { return json({ error: "malformed selection" }, 500, origin); }
    const legs = parsed.legs || [];
    if (!legs.length) return json({ error: "no legs" }, 500, origin);

    for (const leg of legs) {
      const supported = leg.market === "h2h" || leg.market === "spreads" || leg.market === "totals" ||
        String(leg.market).startsWith("alt_sp_") || String(leg.market).startsWith("alt_tot_");
      if (!ESPN_PATH[leg.sport] || !supported) {
        return json({ error: "not_yet_supported", reason: "a leg falls outside the server-settled scope" }, 501, origin);
      }
    }

    // Each leg's own game days (legs can be days apart), one fetch per sport per day.
    const daysBySport: Record<string, Set<string>> = {};
    for (const leg of legs) {
      const set = daysBySport[leg.sport] ||= new Set<string>();
      for (const d of daysAround(new Date(leg.commenceTime).getTime())) set.add(d);
    }
    const eventsBySport: Record<string, any[]> = {};
    await Promise.all(Object.entries(daysBySport).map(async ([sport, days]) => {
      eventsBySport[sport] = await fetchDays(ESPN_PATH[sport], [...days]);
    }));

    const graded: any[] = [];
    let unresolved = 0;
    for (const leg of legs) {
      const ms = new Date(leg.commenceTime).getTime();
      const info = scoreForEvent(findGameEvent(eventsBySport[leg.sport] || [], leg.gameId, leg.homeTeam, leg.awayTeam, ms));
      let result: string | null = null;
      if (info.done) {
        result = gradeLegOutcome(leg.market, leg.selection, leg.line, leg.homeTeam, leg.awayTeam, info.hs!, info.as!, leg.sport);
      } else if (!info.found && Date.now() - ms > STALE_MS) {
        result = "void";
      } else {
        unresolved++;
      }
      graded.push(result ? { ...leg, result } : leg);
    }
    // A parlay is lost the moment any leg loses, like every real book — no waiting on the
    // rest. Otherwise every leg has to be final.
    if (unresolved && !graded.some((l) => l.result === "lost")) {
      return json({ status: "pending", reason: "at least one leg not final yet" }, 200, origin);
    }

    let outcome: string, payout: number;
    if (graded.some((l) => l.result === "lost")) {
      outcome = "lost"; payout = 0;
    } else {
      const liveLegs = graded.filter((l) => l.result === "won");
      if (!liveLegs.length) { outcome = "push"; payout = bet.stake; }
      else { outcome = "won"; payout = Math.round(calcPayout(bet.stake, calcParlayOdds(liveLegs.map((l) => l.odds))) * 100) / 100; }
    }

    await admin.from("bets").update({
      status: outcome, settled_at: new Date().toISOString(), potential_payout: payout,
      selection: JSON.stringify({ legs: graded, rr: !!parsed.rr }),
    }).eq("id", bet.id);
    if (payout > 0) await creditBalance(admin, bet.user_id, payout);

    return json({ status: outcome, payout }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
