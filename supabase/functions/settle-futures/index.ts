// CHALK — settle-futures Edge Function
//
// A championship future resolves once its postseason bracket has actually
// finished (fetchLeagueChampion — real games, real winner, only declared once
// every postseason game in the window is complete); an award future resolves
// off ESPN's real awards record. Both can genuinely take months and simply
// stay pending — never voided just because time has passed, unlike a single
// game. Ported from settleFuturesBet() client-side.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { FUTURES_CONFIG, fetchLeagueChampion, fetchAwardWinner, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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
    if (bet.sport !== "futures") return json({ error: "not_yet_supported" }, 501, origin);

    const cfg = FUTURES_CONFIG.find((c) => c.title === bet.market);
    if (!cfg) return json({ error: "not_yet_supported", reason: "market no longer configured" }, 501, origin);

    const resultName = cfg.type === "championship" ? await fetchLeagueChampion(cfg.sportKey) : await fetchAwardWinner(cfg);
    if (!resultName) return json({ status: "pending", reason: "season not resolved yet" }, 200, origin);

    const result = resultName === bet.selection ? "won" : "lost";
    const payout = result === "won" ? bet.potential_payout : 0;

    await admin.from("bets").update({ status: result, settled_at: new Date().toISOString() }).eq("id", bet.id);
    if (payout > 0) await creditBalance(admin, bet.user_id, payout);

    return json({ status: result, payout }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
