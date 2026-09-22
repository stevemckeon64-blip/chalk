// CHALK — place-parlay Edge Function
//
// Server-side placement for parlays (2+ legs, standard payout) and Round Robin
// combos (each combo placed as its own 2-leg parlay row — same shape, the client
// just sends multiple). Every leg's real current odds are independently
// re-fetched from ESPN here; nothing about odds is trusted from the client.
// Scope matches place-bet: h2h/spreads/totals on the 10 mapped team sports —
// if ANY leg falls outside that, the whole parlay is declined (501) and the
// client falls back to its existing path rather than mixing trust levels
// within one slip.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { ESPN_PATH, extractMarket, findEventAcrossDays, calcPayout, calcParlayOdds, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface LegInput { sport: string; market: string; selection: string; home_team: string; away_team: string; game_id?: string; }

async function resolveLeg(leg: LegInput) {
  const espnPath = ESPN_PATH[leg.sport];
  const supported = leg.market === "h2h" || leg.market === "spreads" || leg.market === "totals";
  if (!espnPath || !supported) return { error: "not_yet_supported" as const };
  const ev = await findEventAcrossDays(espnPath, leg.home_team, leg.away_team);
  if (!ev) return { error: "game not found" as const };
  if (ev.status?.type?.state !== "pre") return { error: "game already started" as const };
  const comp = ev.competitions?.[0];
  const cs = comp?.competitors || [];
  const hc = cs.find((c: any) => c.homeAway === "home");
  const ac = cs.find((c: any) => c.homeAway === "away");
  const homeName = hc?.team?.displayName || hc?.athlete?.displayName || leg.home_team;
  const awayName = ac?.team?.displayName || ac?.athlete?.displayName || leg.away_team;
  const real = extractMarket(ev, leg.market, leg.selection, homeName, awayName);
  if (!real) return { error: "market not available" as const };
  return {
    sport: leg.sport, market: leg.market, selection: leg.selection,
    homeTeam: homeName, awayTeam: awayName, commenceTime: ev.date,
    gameId: leg.game_id ?? ev.id, odds: real.odds, line: real.line,
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const bodyIn = await req.json();
    // Either { legs, stake } for a single parlay, or { combos: [[leg,leg], ...], stake }
    // for Round Robin — combos are placed as one parlay row each.
    const stake = bodyIn.stake;
    if (typeof stake !== "number" || stake <= 0) return json({ error: "invalid stake" }, 400, origin);

    const isRR = Array.isArray(bodyIn.combos);
    const legGroups: LegInput[][] = isRR ? bodyIn.combos : [bodyIn.legs];
    if (!legGroups.length || legGroups.some((g) => !Array.isArray(g) || g.length < 2)) {
      return json({ error: "invalid legs" }, 400, origin);
    }
    const totalStake = isRR ? Math.round(stake * legGroups.length * 100) / 100 : stake;

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) return json({ error: "not authenticated" }, 401, origin);
    const userId = userData.user.id;

    // Resolve every leg of every group against real ESPN data before touching balance —
    // any single leg failing declines the whole thing, nothing partially placed.
    const resolvedGroups: any[][] = [];
    for (const group of legGroups) {
      const resolved = await Promise.all(group.map(resolveLeg));
      const failed = resolved.find((r: any) => r.error);
      if (failed) return json({ error: (failed as any).error, reason: "not_yet_supported" }, 501, origin);
      resolvedGroups.push(resolved);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    let newBalance: number | null = null;
    for (let i = 0; i < 3 && newBalance === null; i++) {
      const { data: profile } = await admin.from("profiles").select("balance").eq("id", userId).single();
      if (!profile) return json({ error: "profile not found" }, 404, origin);
      if (profile.balance < totalStake) return json({ error: "insufficient balance" }, 402, origin);
      const attemptBal = Math.round((profile.balance - totalStake) * 100) / 100;
      const { data, error } = await admin.from("profiles").update({ balance: attemptBal })
        .eq("id", userId).eq("balance", profile.balance).select("id");
      if (!error && data && data.length) newBalance = attemptBal;
    }
    if (newBalance === null) return json({ error: "could not reserve stake, try again" }, 409, origin);

    const rows = resolvedGroups.map((legs) => {
      const odds = calcParlayOdds(legs.map((l) => l.odds));
      const payout = Math.round(calcPayout(stake, odds) * 100) / 100;
      return {
        user_id: userId, sport: legs[0].sport, game_id: "parlay",
        home_team: isRR ? "Round Robin" : "Parlay",
        away_team: isRR ? `${legs.length} Legs` : `${legs.length} Legs`,
        commence_time: legs[0].commenceTime, market: "parlay",
        selection: JSON.stringify({ legs, rr: isRR }),
        line: null, odds, stake, potential_payout: payout, status: "pending",
      };
    });

    const { data: bets, error: insertError } = await admin.from("bets").insert(rows).select();
    if (insertError) {
      await admin.from("profiles").update({ balance: newBalance + totalStake }).eq("id", userId).eq("balance", newBalance);
      return json({ error: "could not place parlay" }, 500, origin);
    }

    return json({ bets, new_balance: newBalance }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
