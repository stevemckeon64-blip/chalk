// CHALK — place-tennis Edge Function
//
// Tennis has no real betting market from ESPN — the client's own real odds are
// derived from real ATP rankings (fetchAtpRankings/fetchTennisOdds), not fetched
// prices. "Real, verified server-side" here means independently re-deriving that
// same ranking-based price rather than trusting whatever number the client sends,
// the same principle as every other place-* function, just a different source
// of truth (real rankings instead of a real market).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { findTennisMatch, fetchAtpRankings, rankOddsFor, calcPayout, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const { selection, home_team, away_team, game_id, stake } = await req.json();
    if (!selection || !home_team || !away_team || typeof stake !== "number" || stake <= 0) {
      return json({ error: "invalid request" }, 400, origin);
    }
    if (selection !== home_team && selection !== away_team) {
      return json({ error: "invalid selection" }, 400, origin);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) return json({ error: "not authenticated" }, 401, origin);
    const userId = userData.user.id;

    const found = await findTennisMatch(home_team, away_team);
    if (!found) return json({ error: "match not found", reason: "no matching real upcoming ATP match" }, 404, origin);
    if (found.comp.status?.type?.state !== "pre") {
      return json({ error: "match already started" }, 409, origin);
    }

    const rankMap = await fetchAtpRankings();
    const priced = rankOddsFor(rankMap, found.home?.id, found.away?.id);
    // Unranked players (qualifiers, wildcards outside the top 150) have no real ranking to
    // price from — -110/-110 is the same honest fallback the client uses, not a guess.
    const odds = priced
      ? (selection === home_team ? priced.homeOdds : priced.awayOdds)
      : -110;

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
      user_id: userId, sport: "tennis_atp", game_id: game_id ?? found.comp.id,
      home_team, away_team, commence_time: found.comp.date,
      market: "h2h", selection, line: null, odds, stake, potential_payout: potentialPayout, status: "pending",
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
