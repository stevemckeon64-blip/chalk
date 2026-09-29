// CHALK — playoff bracket engine.
//
// Shared by the Edge Functions (imported from here) and the app (the same code is inlined
// in index.html with `export` stripped — keep the two copies identical). Pure functions only:
// callers fetch ESPN data and pass it in.
//
// How a bracket works:
//  - You pick the winner of every series. Points per correct pick double each round, so each
//    round is worth about the same (MLB: Wild Card 1, Division Series 2, LCS 4, World Series 8).
//  - A pick is right if that team actually wins that series, whoever it ends up playing.
//  - Your payout depends on your final score, in tiers (perfect / 70% / 50% / 30% of max).
//    The multipliers are priced for YOUR picks: every possible way the postseason can play
//    out is enumerated with real probabilities, and each tier's multiplier is set so the
//    bracket returns 90% of the stake on average (the house keeps 10%, like any book).
//    Bold brackets reach high tiers less often, so they pay more.
//  - Series probabilities come from real data: the posted moneyline for the matchup when a
//    game has one, otherwise each team's real season run differential (Pythagorean win %,
//    combined head-to-head with log5). MLB's own futures feed is frozen at preseason prices,
//    so it isn't used.

export const BRACKET_DEFS = {
  mlb: {
    league: 'mlb', sportKey: 'baseball_mlb', espn: 'baseball/mlb', title: 'MLB Postseason',
    confs: ['AL', 'NL'], seedsPerConf: 6,
    rounds: [
      { key: 'wc', name: 'Wild Card', short: 'WC', pts: 1, bestOf: 3 },
      { key: 'ds', name: 'Division Series', short: 'DS', pts: 2, bestOf: 5 },
      { key: 'cs', name: 'League Championship', short: 'LCS', pts: 4, bestOf: 7 },
      { key: 'ws', name: 'World Series', short: 'WS', pts: 8, bestOf: 7 },
    ],
    // Fixed bracket, in play order: #1 seed gets the 4/5 winner, #2 gets the 3/6 winner.
    slots: [
      { id: 'AL-WC1', r: 'wc', conf: 'AL', a: { seed: 'AL3' }, b: { seed: 'AL6' } },
      { id: 'AL-WC2', r: 'wc', conf: 'AL', a: { seed: 'AL4' }, b: { seed: 'AL5' } },
      { id: 'NL-WC1', r: 'wc', conf: 'NL', a: { seed: 'NL3' }, b: { seed: 'NL6' } },
      { id: 'NL-WC2', r: 'wc', conf: 'NL', a: { seed: 'NL4' }, b: { seed: 'NL5' } },
      { id: 'AL-DS1', r: 'ds', conf: 'AL', a: { seed: 'AL1' }, b: { slot: 'AL-WC2' } },
      { id: 'AL-DS2', r: 'ds', conf: 'AL', a: { seed: 'AL2' }, b: { slot: 'AL-WC1' } },
      { id: 'NL-DS1', r: 'ds', conf: 'NL', a: { seed: 'NL1' }, b: { slot: 'NL-WC2' } },
      { id: 'NL-DS2', r: 'ds', conf: 'NL', a: { seed: 'NL2' }, b: { slot: 'NL-WC1' } },
      { id: 'AL-CS', r: 'cs', conf: 'AL', a: { slot: 'AL-DS1' }, b: { slot: 'AL-DS2' } },
      { id: 'NL-CS', r: 'cs', conf: 'NL', a: { slot: 'NL-DS1' }, b: { slot: 'NL-DS2' } },
      { id: 'WS', r: 'ws', a: { slot: 'AL-CS' }, b: { slot: 'NL-CS' } },
    ],
    // ESPN's headline on each game: "ALWC - Game 1", "NLDS - Game 3", "World Series - Game 7".
    labelRe: (slot) => slot.r === 'ws' ? /^world series\b/i
      : new RegExp('^' + slot.conf + ({ wc: 'WC', ds: 'DS', cs: 'CS' })[slot.r] + '\\b', 'i'),
    // Months to search for results (ESPN accepts whole months, not day ranges).
    months: (season) => [`${season}09`, `${season}10`, `${season}11`],
    PYTHAG_EXP: 1.83,
  },
};

export const TIER_FRACS = [1, 0.7, 0.5, 0.3];
export const TIER_SHARES = [0.2, 0.3, 0.3, 0.2];
export const RTP = 0.9;
export const MAX_MULT = 10000;

const headlineOf = (e) => e?.competitions?.[0]?.notes?.[0]?.headline || '';
const roundOf = (def, slot) => def.rounds.find((r) => r.key === slot.r);
export const slotPts = (def, slot) => roundOf(def, slot).pts;
export const maxPoints = (def) => def.slots.reduce((a, s) => a + slotPts(def, s), 0);

// The 12 seeded teams, from ESPN's standings (apis/v2/sports/<espn>/standings?season=).
export function fieldFromStandings(def, standings) {
  const field = {};
  for (const c of standings?.children || []) {
    const conf = c.abbreviation;
    if (!def.confs.includes(conf)) continue;
    for (const e of c.standings?.entries || []) {
      const st = {};
      for (const x of e.stats || []) st[x.name] = x.value;
      const seed = st.playoffSeed;
      if (!(seed >= 1 && seed <= def.seedsPerConf)) continue;
      field[conf + seed] = {
        key: conf + seed, conf, seed, id: String(e.team.id), name: e.team.displayName,
        abbr: e.team.abbreviation, logo: e.team.logos?.[0]?.href || null,
        w: st.wins, l: st.losses, rs: st.pointsFor, ra: st.pointsAgainst,
      };
    }
  }
  return field;
}

// Real posted moneylines for upcoming postseason games → de-vigged win probability.
// Keyed "Team A|Team B" → P(A beats B), both orientations.
export function marketOddsFromEvents(events) {
  const imp = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
  const out = {};
  for (const e of events || []) {
    if (e.season?.type !== 3 || e.status?.type?.state !== 'pre') continue;
    const c = e.competitions?.[0], o = c?.odds?.[0];
    const h = c?.competitors?.find((x) => x.homeAway === 'home'), a = c?.competitors?.find((x) => x.homeAway === 'away');
    const hml = parseInt(o?.moneyline?.home?.close?.odds), aml = parseInt(o?.moneyline?.away?.close?.odds);
    if (!h || !a || isNaN(hml) || isNaN(aml)) continue;
    const ph = imp(hml) / (imp(hml) + imp(aml));
    const hn = h.team.displayName, an = a.team.displayName;
    // Several games of one series can be posted; the soonest one wins.
    if (out[`${hn}|${an}`] == null) { out[`${hn}|${an}`] = ph; out[`${an}|${hn}`] = 1 - ph; }
  }
  return out;
}

export function makePGame(def, market) {
  const py = (t) => { const a = Math.pow(t.rs, def.PYTHAG_EXP), b = Math.pow(t.ra, def.PYTHAG_EXP); return a / (a + b); };
  return (A, B) => {
    const m = market[`${A.name}|${B.name}`];
    if (m != null) return m;
    const pa = py(A), pb = py(B);
    return (pa - pa * pb) / (pa + pb - 2 * pa * pb);
  };
}

function comb(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }
// P(A wins a best-of series) with per-game win probability p, from a given series score.
export function seriesWinProb(p, bestOf, aWins = 0, bWins = 0) {
  const need = Math.ceil(bestOf / 2), na = need - aWins, nb = need - bWins;
  if (na <= 0) return 1;
  if (nb <= 0) return 0;
  let total = 0;
  for (let k = 0; k < nb; k++) total += comb(na - 1 + k, k) * Math.pow(p, na) * Math.pow(1 - p, k);
  return total;
}

// Who plays in a slot given winners decided so far (team keys like "AL4").
export function slotTeams(slot, winners) {
  return [slot.a.seed || winners[slot.a.slot], slot.b.seed || winners[slot.b.slot]];
}

// Every way the postseason can play out (2^11 = 2048 for MLB) with its probability.
// `fixed` (slotId → key) pins series already decided; `live` (slotId → {aWins, bWins})
// prices series in progress from their current score.
export function enumerateOutcomes(def, field, pGame, fixed = {}, live = {}) {
  const outs = [];
  const winners = {};
  const rec = (i, p) => {
    if (p <= 0) return;
    if (i === def.slots.length) { outs.push({ p, winners: { ...winners } }); return; }
    const s = def.slots[i];
    const [ak, bk] = slotTeams(s, winners);
    let pA;
    if (fixed[s.id]) pA = fixed[s.id] === ak ? 1 : 0;
    else {
      const st = live[s.id] && live[s.id].a === ak ? live[s.id] : null;
      pA = seriesWinProb(pGame(field[ak], field[bk]), roundOf(def, s).bestOf, st ? st.aWins : 0, st ? st.bWins : 0);
    }
    winners[s.id] = ak; rec(i + 1, p * pA);
    winners[s.id] = bk; rec(i + 1, p * (1 - pA));
    delete winners[s.id];
  };
  rec(0, 1);
  return outs;
}

export function scorePicks(def, picks, winners) {
  let pts = 0;
  for (const s of def.slots) if (winners[s.id] && winners[s.id] === picks[s.id]) pts += slotPts(def, s);
  return pts;
}

// Every slot needs a pick, and it has to be one of the two teams your own earlier picks put there.
export function validatePicks(def, field, picks) {
  if (!picks || typeof picks !== 'object') return 'No picks';
  for (const s of def.slots) {
    const [a, b] = slotTeams(s, picks);
    if (!a || !b || !field[a] || !field[b]) return `Missing an earlier pick before ${s.id}`;
    if (picks[s.id] !== a && picks[s.id] !== b) return `Pick a winner for ${s.id}`;
  }
  return null;
}

// Payout tiers for one bracket. Returns { maxPts, tiers: [{min, mult, p}], titleOdds }.
export function priceBracket(def, field, pGame, picks) {
  const maxPts = maxPoints(def);
  const thr = TIER_FRACS.map((f) => Math.ceil(f * maxPts - 1e-9));
  const outs = enumerateOutcomes(def, field, pGame);
  const pTier = thr.map(() => 0);
  for (const o of outs) {
    const pts = scorePicks(def, picks, o.winners);
    const k = thr.findIndex((t) => pts >= t);
    if (k >= 0) pTier[k] += o.p;
  }
  let shares = TIER_SHARES.map((sh, k) => (pTier[k] > 1e-12 ? sh : 0));
  const tot = shares.reduce((a, b) => a + b, 0) || 1;
  shares = shares.map((x) => x / tot);
  let mult = shares.map((sh, k) => (sh > 0 ? (RTP * sh) / pTier[k] : 0));
  // A higher tier never pays less than a lower one; then rescale back to the target return.
  for (let k = mult.length - 2; k >= 0; k--) if (mult[k] && mult[k] < mult[k + 1]) mult[k] = mult[k + 1];
  const ev = mult.reduce((a, m, k) => a + m * pTier[k], 0) || 1;
  mult = mult.map((m) => (m * RTP) / ev);
  mult = mult.map((m) => Math.min(MAX_MULT, m >= 10 ? Math.floor(m) : Math.floor(m * 100) / 100));
  return {
    maxPts,
    tiers: thr.map((t, k) => ({ min: t, mult: mult[k], p: pTier[k] })).filter((t) => t.mult > 0),
  };
}

// Each team's chance to win it all, and each slot's pick probabilities (for the builder UI).
export function teamOdds(def, field, pGame) {
  const outs = enumerateOutcomes(def, field, pGame);
  const last = def.slots[def.slots.length - 1].id;
  const title = {};
  for (const o of outs) title[o.winners[last]] = (title[o.winners[last]] || 0) + o.p;
  return title;
}

// Results so far from ESPN postseason events: winners by slot, plus each started series' score.
export function slotResults(def, field, events) {
  const winners = {}, state = {};
  const byId = {};
  for (const t of Object.values(field)) byId[t.id] = t.key;
  for (const s of def.slots) {
    const [ak, bk] = slotTeams(s, winners);
    if (!ak || !bk) continue;
    const A = field[ak], B = field[bk], re = def.labelRe(s);
    const need = Math.ceil(roundOf(def, s).bestOf / 2);
    const games = (events || []).filter((e) => {
      if (e.season?.type !== 3 || !re.test(headlineOf(e))) return false;
      const ids = (e.competitions?.[0]?.competitors || []).map((c) => String(c.team?.id));
      return ids.includes(A.id) && ids.includes(B.id);
    }).sort((x, y) => new Date(x.date) - new Date(y.date));
    let aWins = 0, bWins = 0;
    for (const g of games) {
      if (!g.status?.type?.completed) continue;
      const w = (g.competitions?.[0]?.competitors || []).find((c) => c.winner === true);
      if (String(w?.team?.id) === A.id) aWins++; else if (String(w?.team?.id) === B.id) bWins++;
    }
    // ESPN's own series tally on the latest game, in case a game is missing from our fetch.
    const ser = games.length ? games[games.length - 1].competitions?.[0]?.series : null;
    if (ser?.competitors) {
      for (const c of ser.competitors) {
        if (String(c.id) === A.id) aWins = Math.max(aWins, c.wins || 0);
        if (String(c.id) === B.id) bWins = Math.max(bWins, c.wins || 0);
      }
    }
    const liveGame = games.find((g) => g.status?.type?.state === 'in');
    const nextGame = games.find((g) => g.status?.type?.state === 'pre');
    state[s.id] = {
      a: ak, b: bk, aWins, bWins, started: games.some((g) => g.status?.type?.state !== 'pre'),
      live: !!liveGame, nextMs: nextGame ? new Date(nextGame.date).getTime() : null,
    };
    if (aWins >= need) winners[s.id] = ak; else if (bWins >= need) winners[s.id] = bk;
  }
  return { winners, state };
}

// Where a bracket stands: points so far, the most it can still reach, whether it's final.
export function bracketStatus(def, picks, results) {
  const out = new Set();
  for (const s of def.slots) {
    const w = results.winners[s.id], st = results.state[s.id];
    if (w && st) out.add(w === st.a ? st.b : st.a);
  }
  let pts = 0, possible = 0, decided = 0;
  for (const s of def.slots) {
    const w = results.winners[s.id], v = slotPts(def, s);
    if (w) { decided++; if (w === picks[s.id]) pts += v; }
    else if (!out.has(picks[s.id])) possible += v;
  }
  return { pts, maxPossible: pts + possible, decided, complete: decided === def.slots.length, eliminated: [...out] };
}

// Tier reached for a score (highest tier whose minimum it meets), or null.
export function tierFor(tiers, pts) {
  return [...tiers].sort((a, b) => b.min - a.min).find((t) => pts >= t.min) || null;
}

// Is the bracket still open? Every first-round series must be on the schedule with the
// seeded teams in it (proves the field is set) and none may have started.
export function firstRoundState(def, field, events) {
  const first = def.slots.filter((s) => s.r === def.rounds[0].key);
  let lockMs = Infinity;
  for (const s of first) {
    const A = field[s.a.seed], B = field[s.b.seed];
    if (!A || !B) return { open: false, reason: 'The playoff field isn’t set yet.' };
    const games = (events || []).filter((e) => {
      if (e.season?.type !== 3 || !def.labelRe(s).test(headlineOf(e))) return false;
      const ids = (e.competitions?.[0]?.competitors || []).map((c) => String(c.team?.id));
      return ids.includes(A.id) && ids.includes(B.id);
    });
    if (!games.length) return { open: false, reason: 'First-round games aren’t on the schedule yet.' };
    for (const g of games) {
      if (g.status?.type?.state !== 'pre') return { open: false, locked: true, reason: 'Brackets locked when the first game started.' };
      lockMs = Math.min(lockMs, new Date(g.date).getTime());
    }
  }
  if (Date.now() >= lockMs) return { open: false, locked: true, reason: 'Brackets locked when the first game started.' };
  return { open: true, lockMs };
}
