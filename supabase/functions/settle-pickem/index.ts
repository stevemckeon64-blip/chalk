// CHALK — settle-pickem Edge Function
//
// Re-grades every pick in a slate against real ESPN results before crediting
// anything, using the exact scoring curve (pickemMultiplier) the client uses —
// waits for every real game in the slate to actually finish, same as
// settlePickemBet() client-side.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { ESPN_PATH, findGameEvent, scoreForEvent, gradeLegOutcome, pickemMultiplier, fetchEventsForRange, corsHeaders, json } from "../_shared/grading.ts";

const STALE_MS = 6 * 60 * 60 * 1000; // matches settlePending()'s client-side staleness window
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
    if (bet.market !== "pickem") return json({ error: "not_yet_supported" }, 501, origin);

    let parsed: any;
    try { parsed = JSON.parse(bet.selection); } catch { return json({ error: "malformed selection" }, 500, origin); }
    const picks = parsed.picks || [];
    if (!picks.length) return json({ error: "no picks" }, 500, origin);

    for (const p of picks) {
      if (!ESPN_PATH[p.sport]) return json({ error: "not_yet_supported" }, 501, origin);
    }

    const times = picks.map((p: any) => new Date(p.commenceTime).getTime());
    const startMs = Math.min(...times) - 24 * 3600 * 1000, endMs = Math.max(...times) + 24 * 3600 * 1000;
    const sportsNeeded = [...new Set(picks.map((p: any) => p.sport))] as string[];
    const eventsBySport: Record<string, any[]> = {};
    await Promise.all(sportsNeeded.map(async (sport) => {
      eventsBySport[sport] = await fetchEventsForRange(ESPN_PATH[sport], startMs, endMs);
    }));

    const graded: any[] = [];
    for (const p of picks) {
      const ms = new Date(p.commenceTime).getTime();
      const info = scoreForEvent(findGameEvent(eventsBySport[p.sport] || [], p.gameId, p.homeTeam, p.awayTeam, ms));
      let result: string;
      if (info.done) {
        result = parsed.mode === "ats"
          ? gradeLegOutcome("spreads", p.pick, p.line, p.homeTeam, p.awayTeam, info.hs!, info.as!, p.sport)
          : gradeLegOutcome("h2h", p.pick, null, p.homeTeam, p.awayTeam, info.hs!, info.as!, p.sport);
      } else if (!info.found && Date.now() - ms > STALE_MS) {
        result = "void"; // postponed/canceled — drops out of the slate like a push
      } else {
        return json({ status: "pending", reason: "at least one game not final yet" }, 200, origin);
      }
      graded.push({ ...p, result });
    }

    const total = parsed.total || picks.length;
    const pushes = graded.filter((g) => g.result === "push" || g.result === "void").length;
    const correct = graded.filter((g) => g.result === "won").length;
    const effectiveTotal = total - pushes;
    const mult = effectiveTotal > 0 ? pickemMultiplier(correct, effectiveTotal) : 0;
    const payout = Math.round(bet.stake * mult * 100) / 100;
    const outcome = payout > 0 ? "won" : "lost";

    // Compare-and-swap on status: two settle calls racing (two tabs, a retry) must not both credit.
    const { data: flipped } = await admin.from("bets").update({
      status: outcome, settled_at: new Date().toISOString(), potential_payout: payout,
      selection: JSON.stringify({ picks: graded, total, correct, pushes, mode: parsed.mode }),
    }).eq("id", bet.id).eq("status", "pending").select("id");
    if (!flipped?.length) return json({ status: outcome, already_settled: true }, 200, origin);
    if (payout > 0) await creditBalance(admin, bet.user_id, payout);

    return json({ status: outcome, payout, correct, effectiveTotal, pushes }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
