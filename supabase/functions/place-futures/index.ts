// CHALK — place-futures Edge Function
//
// Server-side placement for futures bets (championship / award winners). Real
// current odds are re-fetched from ESPN's futures endpoint (sports.core.api.espn.com
// — a different domain from the per-game scoreboard, DraftKings-sourced) rather
// than trusted from the client, same principle as place-bet.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { FUTURES_CONFIG, fetchFuturesOdds, calcPayout, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const { market, selection, stake } = await req.json();
    if (!market || !selection || typeof stake !== "number" || stake <= 0) {
      return json({ error: "invalid request" }, 400, origin);
    }
    const cfg = FUTURES_CONFIG.find((c) => c.title === market);
    if (!cfg) return json({ error: "not_yet_supported", reason: "unknown futures market" }, 501, origin);

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) return json({ error: "not authenticated" }, 401, origin);
    const userId = userData.user.id;

    const odds = await fetchFuturesOdds(cfg, selection);
    if (odds == null) return json({ error: "selection not found", reason: "no real current odds for that pick" }, 404, origin);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const potentialPayout = Math.round(calcPayout(stake, odds) * 100) / 100;

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
      user_id: userId, sport: "futures", game_id: `futures_${cfg.marketId}`,
      home_team: "Futures", away_team: market, commence_time: new Date().toISOString(),
      market, selection, line: null, odds, stake, potential_payout: potentialPayout, status: "pending",
    }).select().single();

    if (insertError) {
      await admin.from("profiles").update({ balance: newBalance + stake }).eq("id", userId).eq("balance", newBalance);
      return json({ error: "could not place bet" }, 500, origin);
    }

    return json({ bet, new_balance: newBalance }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
