// CHALK — cash-out Edge Function
//
// This closes the single most exploitable path found this session: the client
// version of cashOut() takes its payout value as a literal argument with zero
// server-side check — anyone could call cashOut('any-bet-id', 999999, 10) from
// devtools for an instant, arbitrary payout on ANY pending bet. The game-started
// gate and the 45%-of-profit formula were both purely cosmetic UI logic, never
// actually enforced.
//
// Here, the client sends only a bet_id. Every input to the payout — the real
// stake, the real potential_payout, the real commence_time, the real market —
// is read straight from the bet's own row, never trusted from the request.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/grading.ts";

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
    if (bet.status !== "pending") return json({ error: "already settled" }, 409, origin);
    if (bet.sport === "futures") return json({ error: "futures can't be cashed out" }, 400, origin);
    if (bet.market === "pickem") return json({ error: "pick'em can't be cashed out" }, 400, origin);

    const gameStarted = new Date(bet.commence_time).getTime() <= Date.now();
    if (!gameStarted) return json({ error: "game hasn't started yet" }, 409, origin);

    // Same formula as the client displayed, just actually enforced: stake + 45%
    // of the real potential profit, read from the bet's own stored row.
    const cashOutValue = Math.round((bet.stake + (bet.potential_payout - bet.stake) * 0.45) * 100) / 100;

    // Compare-and-swap on status so a double-click, or a settlement racing in at
    // the same moment, can't cash out a bet that's already been paid or lost.
    const { data: rows, error: updateError } = await admin.from("bets")
      .update({ status: "won", potential_payout: cashOutValue, settled_at: new Date().toISOString() })
      .eq("id", bet_id).eq("status", "pending").select("id");
    if (updateError) return json({ error: "cash out failed" }, 500, origin);
    if (!rows || !rows.length) return json({ error: "already settled" }, 409, origin);

    const newBalance = await creditBalance(admin, bet.user_id, cashOutValue);

    return json({ payout: cashOutValue, new_balance: newBalance }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
