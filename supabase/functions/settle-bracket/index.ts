// CHALK — settle-bracket Edge Function
//
// Grades a bracket against real ESPN postseason results (see _shared/bracket.js). Settles when
// every series is decided, or earlier as a loss once even a perfect finish can't reach the
// lowest paying tier. The field is the snapshot stored at placement. A fetch failure throws,
// so a bracket is never graded on missing data.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json, fetchDays } from "../_shared/grading.ts";
import { BRACKET_DEFS, slotResults, bracketStatus, tierFor } from "../_shared/bracket.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: bet, error: betError } = await admin.from("bets").select("*").eq("id", bet_id).single();
    if (betError || !bet) return json({ error: "bet not found" }, 404, origin);
    if (bet.user_id !== userData.user.id) return json({ error: "not your bet" }, 403, origin);
    if (bet.status !== "pending") return json({ status: bet.status, already_settled: true }, 200, origin);
    if (bet.market !== "bracket") return json({ error: "not a bracket" }, 400, origin);

    const sel = JSON.parse(bet.selection);
    const def = (BRACKET_DEFS as any)[sel.league];
    const events = await fetchDays(def.espn, def.months(sel.season), 500);
    const results = slotResults(def, sel.field, events);
    const st = bracketStatus(def, sel.picks, results);
    const lowest = Math.min(...sel.tiers.map((t: any) => t.min));
    if (!st.complete && st.maxPossible >= lowest) {
      return json({ status: "pending", points: st.pts, maxPossible: st.maxPossible, decided: st.decided }, 200, origin);
    }
    const tier = st.complete ? tierFor(sel.tiers, st.pts) : null;
    const payout = tier ? Math.round(bet.stake * tier.mult * 100) / 100 : 0;
    const outcome = payout > 0 ? "won" : "lost";
    const { data: flipped } = await admin.from("bets").update({
      status: outcome, settled_at: new Date().toISOString(), potential_payout: payout,
      selection: JSON.stringify({ ...sel, results: results.winners, points: st.pts }),
    }).eq("id", bet.id).eq("status", "pending").select("id");
    if (!flipped?.length) return json({ status: outcome, already_settled: true }, 200, origin);
    if (payout > 0) {
      for (let i = 0; i < 3; i++) {
        const { data: p } = await admin.from("profiles").select("balance").eq("id", bet.user_id).single();
        const nb = Math.round((p.balance + payout) * 100) / 100;
        const { data: ok } = await admin.from("profiles").update({ balance: nb }).eq("id", bet.user_id).eq("balance", p.balance).select("id");
        if (ok?.length) break;
      }
    }
    return json({ status: outcome, payout, points: st.pts }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
