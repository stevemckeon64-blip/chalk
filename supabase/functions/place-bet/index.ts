// CHALK — place-bet Edge Function
//
// Server-side placement for single (non-parlay, non-Pick'em) moneyline / spread
// / total bets. See _shared/grading.ts for the ported logic and
// supabase/functions/place-parlay for the parlay equivalent.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { ESPN_PATH, extractMarket, findEventAcrossDays, calcPayout, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const body = await req.json();
    const { sport, market, selection, home_team, away_team, game_id, stake } = body;

    if (!sport || !market || !selection || !home_team || !away_team || !stake) {
      return json({ error: "missing required fields" }, 400, origin);
    }
    if (typeof stake !== "number" || stake <= 0) return json({ error: "invalid stake" }, 400, origin);

    const espnPath = ESPN_PATH[sport];
    const supportedMarket = market === "h2h" || market === "spreads" || market === "totals";
    if (!espnPath || !supportedMarket) {
      return json({ error: "not_yet_supported", reason: "this bet type isn't server-placed yet" }, 501, origin);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) return json({ error: "not authenticated" }, 401, origin);
    const userId = userData.user.id;

    const ev = await findEventAcrossDays(espnPath, home_team, away_team);
    if (!ev) return json({ error: "game not found", reason: "no matching upcoming ESPN event" }, 404, origin);
    if (ev.status?.type?.state !== "pre") {
      return json({ error: "game already started", reason: "bets can only be placed on games that haven't started" }, 409, origin);
    }

    const comp = ev.competitions?.[0];
    const cs = comp?.competitors || [];
    const hc = cs.find((c: any) => c.homeAway === "home");
    const ac = cs.find((c: any) => c.homeAway === "away");
    const homeName = hc?.team?.displayName || hc?.athlete?.displayName || home_team;
    const awayName = ac?.team?.displayName || ac?.athlete?.displayName || away_team;

    const real = extractMarket(ev, market, selection, homeName, awayName);
    if (!real) return json({ error: "market not available", reason: "no real current odds for that selection" }, 404, origin);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const potentialPayout = Math.round(calcPayout(stake, real.odds) * 100) / 100;

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
      user_id: userId, sport, game_id: game_id ?? ev.id,
      home_team: homeName, away_team: awayName,
      commence_time: ev.date, market, selection,
      line: real.line, odds: real.odds, stake, potential_payout: potentialPayout,
      status: "pending",
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
