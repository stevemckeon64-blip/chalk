// CHALK — place-bracket Edge Function
//
// Quotes and places playoff brackets (see _shared/bracket.js for how pricing works).
// { league, picks, quote_only: true } → the payout tiers for those picks (no sign-in needed).
// { league, picks, stake, quote } → places it if the fresh price is still within 3% of the
// quote the player saw, otherwise returns the new price to confirm. Everything that sets the
// price — the seeded field, the posted lines, the lock — is fetched here, never trusted from
// the app.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json, espnJson, fetchDays, fmtDay, futuresSeason } from "../_shared/grading.ts";
import { BRACKET_DEFS, fieldFromStandings, marketOddsFromEvents, makePGame, validatePicks, priceBracket, firstRoundState } from "../_shared/bracket.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

async function loadMarket(def: any, season: number) {
  const standings = await espnJson(`https://site.web.api.espn.com/apis/v2/sports/${def.espn}/standings?season=${season}`);
  const now = Date.now();
  const events = await fetchDays(def.espn, [-1, 0, 1, 2, 3].map((i) => fmtDay(now + i * 864e5)));
  return { field: fieldFromStandings(def, standings), events };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  try {
    const { league, picks, stake, quote, quote_only } = await req.json();
    const def = (BRACKET_DEFS as any)[league];
    if (!def) return json({ error: "unknown league" }, 400, origin);
    const season = futuresSeason(def.league);
    const { field, events } = await loadMarket(def, season);
    const fr = firstRoundState(def, field, events);
    if (!fr.open) return json({ error: "closed", reason: fr.reason }, 409, origin);
    const bad = validatePicks(def, field, picks);
    if (bad) return json({ error: "invalid picks", reason: bad }, 400, origin);
    const priced = priceBracket(def, field, makePGame(def, marketOddsFromEvents(events)), picks);
    if (quote_only) return json({ quote: priced, lockMs: fr.lockMs }, 200, origin);

    if (typeof stake !== "number" || !(stake > 0)) return json({ error: "invalid stake" }, 400, origin);
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: authError } = await callerClient.auth.getUser();
    if (authError || !userData?.user) return json({ error: "not authenticated" }, 401, origin);
    const userId = userData.user.id;

    // The player accepted a specific set of multipliers; don't place at a worse one.
    const seen = Array.isArray(quote?.tiers) ? quote.tiers : null;
    if (!seen) return json({ error: "price_changed", quote: priced }, 409, origin);
    for (const t of priced.tiers) {
      const was = seen.find((x: any) => x.min === t.min);
      if (!was || t.mult < was.mult * 0.97) return json({ error: "price_changed", quote: priced }, 409, origin);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
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

    const top = Math.max(...priced.tiers.map((t: any) => t.mult));
    const last = def.slots[def.slots.length - 1].id;
    const { data: bet, error: insertError } = await admin.from("bets").insert({
      user_id: userId, sport: def.sportKey, game_id: `bracket_${def.league}_${season}`,
      home_team: `${def.title} Bracket`, away_team: field[picks[last]].name,
      commence_time: new Date(fr.lockMs).toISOString(), market: "bracket",
      // The field is stored with the bet so settlement grades against exactly what was priced.
      selection: JSON.stringify({ league: def.league, season, picks, field, tiers: priced.tiers.map((t: any) => ({ min: t.min, mult: t.mult })), maxPts: priced.maxPts }),
      line: null, odds: Math.round((top - 1) * 100), stake,
      potential_payout: Math.round(stake * top * 100) / 100, status: "pending",
    }).select().single();
    if (insertError) {
      await admin.from("profiles").update({ balance: newBalance + stake }).eq("id", userId).eq("balance", newBalance);
      return json({ error: "could not place bracket" }, 500, origin);
    }
    return json({ bet, new_balance: newBalance }, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
