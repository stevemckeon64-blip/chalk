// CHALK — settle-bet Edge Function
//
// Server-side re-verification for single (non-parlay, non-Pick'em) moneyline /
// spread / total bets, on the sports with a plain ESPN scoreboard. See
// _shared/grading.ts for the ported grading logic and supabase/functions/
// settle-parlay for the parlay equivalent.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { ESPN_PATH, scoreFor, gradeLegOutcome, fetchScoreboard, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

async function creditBalance(admin: any, userId: string, delta: number, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const { data: profile } = await admin.from("profiles").select("balance").eq("id", userId).single();
    if (!profile) return null;
    const newBal = Math.round((profile.balance + delta) * 100) / 100;
    const { data, error } = await admin
      .from("profiles").update({ balance: newBal })
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

    const espnPath = ESPN_PATH[bet.sport];
    const supportedMarket =
      bet.market === "h2h" || bet.market === "spreads" || bet.market === "totals" ||
      bet.market.startsWith("alt_sp_") || bet.market.startsWith("alt_tot_");
    if (!espnPath || !supportedMarket) {
      return json({ error: "not_yet_supported", reason: "this bet type isn't server-settled yet" }, 501, origin);
    }

    const events = await fetchScoreboard(espnPath);
    const info = scoreFor(events, bet.home_team, bet.away_team);
    if (!info.done) return json({ status: "pending", reason: "game not final yet" }, 200, origin);

    const result = gradeLegOutcome(bet.market, bet.selection, bet.line, bet.home_team, bet.away_team, info.hs!, info.as!);
    const payout = result === "won" ? bet.potential_payout : result === "push" ? bet.stake : 0;

    await admin.from("bets").update({ status: result, settled_at: new Date().toISOString() }).eq("id", bet.id);
    if (payout > 0) await creditBalance(admin, bet.user_id, payout);

    return json({ status: result, payout }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
