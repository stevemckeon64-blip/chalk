// CHALK — settle-tennis Edge Function
//
// Tennis matches don't carry a numeric score in ESPN's data — they're resolved
// by a real winner boolean on the competitor, not points, so this checks that
// instead of a score comparison. Ported from fetchTennisPseudoEvents()'s
// approach client-side (scan real recent results for a completed match with
// this exact matchup).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { findCompletedTennisMatch, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const STALE_MS = 6 * 60 * 60 * 1000;

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
    if (bet.sport !== "tennis_atp" || bet.market !== "h2h") return json({ error: "not_yet_supported" }, 501, origin);

    const found = await findCompletedTennisMatch(bet.home_team, bet.away_team);
    let result: string;
    if (found) {
      const winnerName = found.winnerIsHome ? bet.home_team : bet.away_team;
      result = winnerName === bet.selection ? "won" : "lost";
    } else if (Date.now() - new Date(bet.commence_time).getTime() > STALE_MS) {
      result = "void";
    } else {
      return json({ status: "pending", reason: "match not final yet" }, 200, origin);
    }
    const payout = result === "won" ? bet.potential_payout : result === "void" ? bet.stake : 0;

    await admin.from("bets").update({ status: result, settled_at: new Date().toISOString() }).eq("id", bet.id);
    if (payout > 0) await creditBalance(admin, bet.user_id, payout);

    return json({ status: result, payout }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
