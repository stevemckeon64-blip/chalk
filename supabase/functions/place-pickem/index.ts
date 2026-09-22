// CHALK — place-pickem Edge Function
//
// Server-side placement for Pick'em slates (Straight Up or Against the Spread).
// Unlike a moneyline/parlay bet, Pick'em's payout doesn't depend on market
// odds at all — it's a fixed multiplier curve on how many picks land — so the
// only things worth independently verifying here are: every game in the slate
// is real and hasn't started, and (ATS mode) the real current spread line is
// used rather than whatever the client claims.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { ESPN_PATH, matchEvent, extractMarket, pickemMultiplier, calcParlayOdds, corsHeaders, json } from "../_shared/grading.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface PickInput { game_id: string; sport: string; home_team: string; away_team: string; pick: string; }

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const body = await req.json();
    const { sport, mode, picks, stake } = body as { sport: string; mode: "su" | "ats"; picks: PickInput[]; stake: number };

    if (!sport || !mode || !Array.isArray(picks) || picks.length < 1 || picks.length > 10) {
      return json({ error: "invalid slate" }, 400, origin);
    }
    if (typeof stake !== "number" || stake <= 0) return json({ error: "invalid stake" }, 400, origin);
    const espnPath = ESPN_PATH[sport];
    if (!espnPath) return json({ error: "not_yet_supported" }, 501, origin);

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) return json({ error: "not authenticated" }, 401, origin);
    const userId = userData.user.id;

    // Resolve every pick against a real, not-yet-started ESPN event before touching
    // balance — one bad pick declines the whole slate, matching the client's own
    // "every game must be picked, none may have started" rule.
    const resolvedPicks: any[] = [];
    let earliest = Infinity;
    for (const p of picks) {
      if (!p.pick) return json({ error: "every game needs a pick" }, 400, origin);
      // Slate submission searches today + the next few days (matches loadPickem's
      // own upcoming-slate window), not the wider look-back settlement needs.
      let ev: any = null;
      for (let i = 0; i < 8 && !ev; i++) {
        const d = new Date(); d.setDate(d.getDate() + i);
        const fmt = d.toISOString().slice(0, 10).replace(/-/g, "");
        const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${fmt}`);
        const j = await res.json().catch(() => ({ events: [] }));
        ev = matchEvent(j.events || [], p.home_team, p.away_team);
      }
      if (!ev) return json({ error: "game not found", reason: `no matching event for ${p.home_team} vs ${p.away_team}` }, 404, origin);
      if (ev.status?.type?.state !== "pre") return json({ error: "game already started" }, 409, origin);
      const commenceMs = new Date(ev.date).getTime();
      if (commenceMs < earliest) earliest = commenceMs;

      const comp = ev.competitions?.[0];
      const cs = comp?.competitors || [];
      const hc = cs.find((c: any) => c.homeAway === "home");
      const ac = cs.find((c: any) => c.homeAway === "away");
      const homeName = hc?.team?.displayName || p.home_team;
      const awayName = ac?.team?.displayName || p.away_team;

      let line: number | null = null;
      if (mode === "ats") {
        const real = extractMarket(ev, "spreads", p.pick, homeName, awayName);
        if (!real) return json({ error: "spread not available", reason: `no real spread for ${homeName} vs ${awayName}` }, 404, origin);
        line = real.line;
      } else if (p.pick !== homeName && p.pick !== awayName) {
        return json({ error: "invalid pick", reason: "pick must be one of the two real teams" }, 400, origin);
      }

      resolvedPicks.push({ gameId: p.game_id ?? ev.id, sport, homeTeam: homeName, awayTeam: awayName, commenceTime: ev.date, pick: p.pick, line });
    }
    if (!isFinite(earliest)) return json({ error: "could not resolve slate" }, 500, origin);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const total = resolvedPicks.length;
    const perfectMult = pickemMultiplier(total, total);
    const perfectPayout = Math.round(stake * perfectMult * 100) / 100;
    const perfectDecimal = perfectMult + 1;
    const pickemOdds = perfectDecimal >= 2 ? Math.round((perfectDecimal - 1) * 100) : Math.round(-100 / (perfectDecimal - 1));

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
      user_id: userId, sport, game_id: "pickem",
      home_team: `${total}-Game Pick'em${mode === "ats" ? " (ATS)" : ""}`,
      away_team: sport, commence_time: new Date(earliest).toISOString(), market: "pickem",
      selection: JSON.stringify({ picks: resolvedPicks, total, mode }),
      line: null, odds: pickemOdds, stake, potential_payout: perfectPayout, status: "pending",
    }).select().single();

    if (insertError) {
      await admin.from("profiles").update({ balance: newBalance + stake }).eq("id", userId).eq("balance", newBalance);
      return json({ error: "could not place slate" }, 500, origin);
    }

    return json({ bet, new_balance: newBalance }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
