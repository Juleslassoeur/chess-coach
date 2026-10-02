let EXAMPLE = null; // chargé depuis /data/example.json au démarrage
const ENGINE_URL = 'vendor/stockfish.asm.js';

/* ---------- réglages (localStorage) ---------- */
const SKEY = 'cc-settings', DBKEY = 'cc-db';
function getSettings(){ try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } }
function saveSettings(x){ try { localStorage.setItem(SKEY, JSON.stringify(x)); } catch {} }
let settings = getSettings();

/* ---------- stockage local (remplace l'ancien serveur) ---------- */
function loadDb(){ try { const d = JSON.parse(localStorage.getItem(DBKEY)) || {}; d.collections ??= {}; d.docs ??= {}; return d; } catch { return {collections:{}, docs:{}}; } }
let localDb = loadDb();
function persistDb(){
  for (let tries = 0; tries < 12; tries++){
    try { localStorage.setItem(DBKEY, JSON.stringify(localDb)); return true; }
    catch { // stockage plein : on retire la plus ancienne analyse et on réessaie
      const an = localDb.collections.analyses || {};
      const oldest = Object.entries(an).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))[0];
      if (!oldest) return false;
      delete an[oldest[0]];
    }
  }
  return false;
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
const dbList = col => Object.entries(localDb.collections[col] || {}).map(([id, v]) => ({id, ...v}));
function dbAdd(col, value){ const id = uuid(); (localDb.collections[col] ??= {})[id] = value; const ok = persistDb(); return {id, ok, ...value}; }
const dbGet = key => localDb.docs[key] ?? null;
function dbSet(key, value){ localDb.docs[key] = value; return persistDb(); }

/* ---------- IA (clé de l'utilisateur, appel direct depuis le navigateur) ---------- */
function parseJsonLoose(text){
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  throw Object.assign(new Error('Réponse de l\'IA illisible (JSON invalide)'), {code: 'invalid_json'});
}
const aiProvider = () => { const k = (settings.aiKey || '').trim(); return !k ? null : (k.startsWith('AIza') ? 'gemini' : 'anthropic'); };
async function explainAI(prompt){
  const key = (settings.aiKey || '').trim();
  if (!key) throw Object.assign(new Error('Aucune clé IA : ajoute-la dans l\'onglet Réglages.'), {code: 'no_key'});
  const suffix = '\n\nRéponds uniquement avec le JSON demandé, sans texte autour.';
  if (aiProvider() === 'gemini'){
    const model = (settings.aiModel || '').trim() || 'gemini-3.8-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({contents: [{parts: [{text: prompt + suffix}]}], generationConfig: {responseMimeType: 'application/json', maxOutputTokens: 16000}})});
    const data = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(data?.error?.message || `API Gemini : erreur ${r.status}`), {code: 'api_error'});
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) throw Object.assign(new Error('Réponse de l\'IA vide'), {code: 'empty_response'});
    return parseJsonLoose(text);
  }
  const model = (settings.aiModel || '').trim() || 'claude-sonnet-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json'},
    body: JSON.stringify({model, max_tokens: 16000, messages: [{role: 'user', content: prompt + suffix}]})});
  const data = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || `API Anthropic : erreur ${r.status}`), {code: 'api_error'});
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseJsonLoose(text);
}

/* ---------- Lichess (jeton de l'utilisateur) ---------- */
const MAX_PUZZLES = 5000;
function mergePuzzles(incoming){
  const current = dbGet('puzzles_lichess') || {entries: []};
  const byKey = new Map(current.entries.map(e => [`${e.id}:${e.d}`, e]));
  let added = 0;
  for (const e of incoming){ const k = `${e.id}:${e.d}`; if (!byKey.has(k)){ byKey.set(k, e); added++; } }
  const entries = [...byKey.values()].sort((a, b) => b.d - a.d).slice(0, MAX_PUZZLES);
  const doc = {entries, updatedAt: Date.now()};
  dbSet('puzzles_lichess', doc);
  return {...doc, added};
}
async function fetchPuzzleActivity({since, max} = {}){
  const url = new URL('https://lichess.org/api/puzzle/activity');
  if (since) url.searchParams.set('since', String(since));
  if (max) url.searchParams.set('max', String(max));
  const r = await fetch(url, {headers: {Authorization: `Bearer ${(settings.lichessToken || '').trim()}`, Accept: 'application/x-ndjson'}});
  if (r.status === 401) throw new Error('Lichess refuse le jeton : vérifie-le dans Réglages (scope puzzle:read).');
  if (r.status === 429) throw new Error('Lichess limite les requêtes : réessaie dans une minute.');
  if (!r.ok) throw new Error(`Lichess : erreur ${r.status}`);
  const text = await r.text();
  const out = [];
  for (const line of text.split('\n')){
    if (!line.trim()) continue;
    try { const o = JSON.parse(line);
      if (o?.puzzle?.id && typeof o.date === 'number') out.push({id: o.puzzle.id, d: o.date, w: !!o.win, r: o.puzzle.rating || 0, t: (o.puzzle.themes || []).slice(0, 12)});
    } catch { /* ligne ignorée */ }
  }
  return out;
}

/* ---------- Chess.com PubAPI (public, sans clé) ---------- */
async function ccJson(url){
  const r = await fetch(url, {headers: {Accept: 'application/json'}});
  if (r.status === 404) throw new Error('Joueur Chess.com introuvable.');
  if (r.status === 429) throw new Error('Chess.com limite les requêtes : réessaie dans une minute.');
  if (!r.ok) throw new Error(`Chess.com : erreur ${r.status}`);
  return r.json();
}
async function ccPlayerStats(username){
  const x = await ccJson(`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/stats`);
  return {rapid: x.chess_rapid?.last?.rating ?? null, rapidBest: x.chess_rapid?.best?.rating ?? null,
    blitz: x.chess_blitz?.last?.rating ?? null, tactics: x.tactics?.highest?.rating ?? null, puzzleRush: x.puzzle_rush?.best?.score ?? null};
}
async function ccRecentGames(username){
  const u = username.toLowerCase();
  const {archives = []} = await ccJson(`https://api.chess.com/pub/player/${encodeURIComponent(u)}/games/archives`);
  const months = archives.slice(-2).reverse();
  const games = [];
  for (const m of months){
    const {games: gs = []} = await ccJson(m);
    for (const g of gs.reverse()){
      if (!g.pgn || g.rules !== 'chess') continue;
      const me = g.white?.username?.toLowerCase() === u ? 'white' : 'black';
      const opp = me === 'white' ? g.black : g.white;
      const res = g[me]?.result;
      const outcome = res === 'win' ? 'victoire' : ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(res) ? 'nulle' : 'défaite';
      const end = new Date((g.end_time || 0) * 1000);
      const date = end.toLocaleDateString('fr-FR');
      games.push({label: `${date} · ${outcome} vs ${opp?.username} (${opp?.rating}) · ${g.time_class}`,
        pgn: g.pgn, url: g.url, endTime: (g.end_time || 0) * 1000, date, outcome, timeClass: g.time_class,
        me: {color: me, rating: g[me]?.rating}, opp: {name: opp?.username || '?', rating: opp?.rating || ''}});
    }
  }
  return games.slice(0, 30);
}
const FILES = 'abcdefgh', S = 45;
const ARROW = {g:'#2E8B57', r:'#D14B32', b:'#2F6DB5'};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rich = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const fmtEval = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1).replace('.', ',');

const WORK = {
  fork:{l:'Fourchette et double attaque', k:'Tactique', s:'fork'},
  pin:{l:'Clouage', k:'Tactique', s:'pin'},
  skewer:{l:'Enfilade', k:'Tactique', s:'skewer'},
  discovered:{l:'Attaque à la découverte', k:'Tactique', s:'discoveredAttack'},
  defender:{l:'Élimination du défenseur', k:'Tactique', s:'capturingDefender'},
  hanging:{l:'Pièce en prise', k:'Tactique', s:'hangingPiece'},
  defense:{l:'Voir la menace adverse', k:'Tactique', s:'defensiveMove'},
  mate:{l:'Mats', k:'Tactique', s:'mate'},
  kingattack:{l:'Attaque sur le roi', k:'Tactique', s:'kingsideAttack'},
  deflection:{l:'Déviation et attraction', k:'Tactique', s:'deflection'},
  endgame:{l:'Finales', k:'Finale', s:'endgame'},
  opening_punish:{l:'Punir les coups faibles en ouverture', k:'Ouverture', s:'opening'},
  development:{l:'Développement et roque', k:'Ouverture', url:'https://lichess.org/practice',
    how:'Aucune plateforme ne permet de suivre tes leçons via API : ta progression ici se lit sur l\'indicateur ▲/▼ (tes erreurs sur ce thème baissent-elles au fil des parties ?). Check-list en partie : cavaliers et fous sortis avant d\'attaquer, roque avant le coup 10, un seul coup de dame dans l\'ouverture.'},
  repertoire:{l:"Répertoire d'ouverture", k:'Ouverture', url:'https://www.chessbook.com'},
  center:{l:'Centre, structure et cases fortes', k:'Stratégie', url:'https://lichess.org/practice',
    how:'Suivi via l\'indicateur ▲/▼ (pas de suivi de leçons possible par API). Ça se travaille en partie lente (15|10) : avant chaque poussée de pion, demande-toi quelle case tu affaiblis. Garde au moins un pion au centre et ne pousse pas les pions devant ton roi roqué.'},
  timing:{l:'Plans et timing', k:'Stratégie', url:'https://lichess.org/practice',
    how:'Suivi via l\'indicateur ▲/▼ (pas de suivi de leçons possible par API). Après chaque coup adverse, deux questions : qu\'est-ce qu\'il menace ? qu\'est-ce qu\'il ne défend plus ? S\'il ne menace rien, joue TON plan. Repère dans tes analyses où tu as répondu à une fausse menace.'},
  mixed:{l:'Puzzles mélangés (sans thème)', k:'Mélange', s:'mix'},
};
const workLabel = k => WORK[k]?.l || 'Non classé';
const LI_MAP = {fork:'fork', pin:'pin', skewer:'skewer', discoveredAttack:'discovered', doubleCheck:'discovered', capturingDefender:'defender',
  hangingPiece:'hanging', trappedPiece:'hanging', defensiveMove:'defense', deflection:'deflection', attraction:'deflection', interference:'deflection', clearance:'deflection',
  kingsideAttack:'kingattack', queensideAttack:'kingattack', attackingF2F7:'kingattack', exposedKing:'kingattack', opening:'opening_punish'};
const liWorks = themes => { const out = new Set(); for (const th of (themes||[])){ if (LI_MAP[th]) out.add(LI_MAP[th]); else if (/^mate|Mate$/.test(th)) out.add('mate'); else if (/Endgame$|^endgame$/.test(th)) out.add('endgame'); } if (!out.size) out.add('mixed'); return [...out]; };
let liEntries = [];

/* ---------- board ---------- */
function sqXY(name, orient){ const f = FILES.indexOf(name[0]), r = +name[1]-1;
  return orient === 'b' ? [(7-f)*S, r*S] : [f*S, (7-r)*S]; }
function parseFen(fen){ const out = {}; fen.split(' ')[0].split('/').forEach((row,i) => { let f = 0;
  for (const ch of row){ if (/\d/.test(ch)) f += +ch; else { out[FILES[f]+(8-i)] = ch; f++; } } }); return out; }
function boardSVG(fr, orient){
  let s = `<svg viewBox="0 0 ${8*S} ${8*S}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Position après ${esc(fr.san)}">`;
  s += `<defs>${['g','r','b'].map(k=>`<marker id="ah${k}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${ARROW[k]}"/></marker>`).join('')}</defs>`;
  for (let f=0; f<8; f++) for (let r=0; r<8; r++){ const [x,y] = sqXY(FILES[f]+(r+1), orient);
    s += `<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="${(f+r)%2 ? '#ECE7D5' : '#86A07A'}"/>`; }
  if (fr.from) for (const q of [fr.from, fr.to]){ const [x,y] = sqXY(q, orient); s += `<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="#F2D96B" opacity=".55"/>`; }
  for (const q of (fr.marks||[])){ const [x,y] = sqXY(q, orient); s += `<rect x="${x+2}" y="${y+2}" width="${S-4}" height="${S-4}" fill="none" stroke="#2F6DB5" stroke-width="4" rx="3"/>`; }
  const pos = parseFen(fr.fen);
  for (const q in pos){ const p = pos[q]; const key = (p === p.toUpperCase() ? 'w' : 'b') + p.toUpperCase(); const [x,y] = sqXY(q, orient);
    s += `<use href="#p${key}" x="${x}" y="${y}"/>`; }
  for (const [a,b,c] of (fr.arrows||[])){ if (!ARROW[c]) continue;
    let [x1,y1] = sqXY(a, orient), [x2,y2] = sqXY(b, orient); x1+=S/2; y1+=S/2; x2+=S/2; y2+=S/2;
    const d = Math.hypot(x2-x1,y2-y1) || 1, ux=(x2-x1)/d, uy=(y2-y1)/d; x2 -= ux*14; y2 -= uy*14; x1 += ux*6; y1 += uy*6;
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${ARROW[c]}" stroke-width="7" stroke-linecap="round" opacity=".82" marker-end="url(#ah${c})"/>`; }
  for (let i=0;i<8;i++){
    const file = orient === 'b' ? FILES[7-i] : FILES[i], rank = orient === 'b' ? i+1 : 8-i;
    s += `<text x="${i*S+S-4}" y="${8*S-4}" font-size="10" text-anchor="end" font-family="monospace" fill="${i%2===0?'#86A07A':'#ECE7D5'}">${file}</text>`;
    s += `<text x="3" y="${i*S+11}" font-size="10" font-family="monospace" fill="${i%2===0?'#86A07A':'#ECE7D5'}">${rank}</text>`; }
  return s + '</svg>';
}
const SRC = {played:'coups de la partie', game:'coups de la partie', best:'variante du moteur (pas jouée)', alt:'variante (pas jouée)'};
function viewer(frames, orient, opt = {}){
  const v = document.createElement('div'); v.className = 'viewer'; let i = 0; const kind = opt.kind || 'game';
  v.innerHTML = `<div class="vlabel ${kind}">${opt.title ? `<div class="top"><b>${esc(opt.title)}</b>${opt.eval ? `<span class="evalchip">éval. ${esc(opt.eval)}</span>` : ''}</div>` : ''}<span class="src">${SRC[kind]}</span></div>
    <div class="board" tabindex="0" aria-label="Échiquier, flèches gauche et droite pour changer de coup"></div>
    <div class="ctrl"><button type="button" data-a="first" aria-label="Début">⏮</button><button type="button" data-a="prev" aria-label="Coup précédent">◀</button><button type="button" data-a="next" aria-label="Coup suivant">▶</button><span class="count"></span></div>
    <div class="moves">${frames.map((f,k)=>`<button type="button" data-k="${k}">${k===0?'départ':esc(f.san)}</button>`).join('')}</div>
    <div class="note" aria-live="polite"></div>`;
  const board = v.querySelector('.board'), note = v.querySelector('.note'), count = v.querySelector('.count'), btns = v.querySelectorAll('.moves button');
  function show(k){ i = Math.max(0, Math.min(frames.length-1, k)); const fr = frames[i];
    board.innerHTML = boardSVG(fr, orient); note.textContent = fr.note || fr.san; count.textContent = `${i}/${frames.length-1}`;
    btns.forEach((b,n)=>b.classList.toggle('on', n===i));
    v.querySelector('[data-a=prev]').disabled = v.querySelector('[data-a=first]').disabled = i===0;
    v.querySelector('[data-a=next]').disabled = i===frames.length-1; }
  v.querySelector('.ctrl').addEventListener('click', e => { const a = e.target.closest('button')?.dataset.a;
    if (a==='next') show(i+1); if (a==='prev') show(i-1); if (a==='first') show(0); });
  v.querySelector('.moves').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(+b.dataset.k); });
  board.addEventListener('keydown', e => { if (e.key==='ArrowRight'){show(i+1);e.preventDefault();} if (e.key==='ArrowLeft'){show(i-1);e.preventDefault();} });
  let tx = null; board.addEventListener('touchstart', e => tx = e.touches[0].clientX, {passive:true});
  board.addEventListener('touchend', e => { if (tx===null) return; const dx = e.changedTouches[0].clientX - tx; if (Math.abs(dx)>40) show(i + (dx<0?1:-1)); tx=null; });
  show(0); return v;
}
function analysisHTML(blocks, rule){
  let h = '';
  for (const b of (blocks||[])){
    if (b.h) h += `<h4>${rich(b.h)}</h4>`;
    if (b.p) h += `<p>${rich(b.p)}</p>`;
    if (Array.isArray(b.ul)) h += `<ul>${b.ul.map(x=>`<li>${rich(x)}</li>`).join('')}</ul>`;
  }
  if (rule) h += `<p class="rule">${rich(rule)}</p>`;
  return `<div class="analysis">${h}</div>`;
}
function curveSVG(r){
  const sign = r.meta.color === 'w' ? 1 : -1;
  const ev = r.evals.map(x => sign*x/100); const W=700,H=220,L=34,Rr=10,T=12,Bm=30, maxv=7;
  const n = Math.max(ev.length-1, 1);
  const X = k => L + k*(W-L-Rr)/n, Y = v => T + (maxv - Math.max(-maxv,Math.min(maxv,v)))*(H-T-Bm)/(2*maxv);
  let s = '';
  for (const v of [-6,-4,-2,0,2,4,6]) s += `<line x1="${L}" x2="${W-Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="${v===0?1.5:1}"/><text x="${L-6}" y="${Y(v)+4}" font-size="11" text-anchor="end" fill="var(--muted)" font-family="monospace">${v>0?'+'+v:v}</text>`;
  const pts = ev.map((v,k)=>`${X(k)},${Y(v)}`).join(' ');
  s += `<polygon points="${X(0)},${Y(0)} ${pts} ${X(ev.length-1)},${Y(0)}" fill="var(--best)" opacity=".14"/><polyline points="${pts}" fill="none" stroke="var(--best)" stroke-width="2.2" stroke-linejoin="round"/>`;
  const moves = Math.ceil(n/2), step = moves > 40 ? 5 : moves > 20 ? 3 : 2;
  for (let m=1; m<=moves; m+=step) s += `<text x="${X(2*m-1)}" y="${H-10}" font-size="11" text-anchor="middle" fill="var(--muted)" font-family="monospace">${m}</text>`;
  for (const [k,t] of (r.marks||[])){ if (k > n) continue; const up = ev[k] > 3, right = k > n*0.8;
    s += `<circle cx="${X(k)}" cy="${Y(ev[k])}" r="4.5" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/><text x="${X(k)+(right?-8:8)}" y="${Y(ev[k])+(up?20:-12)}" font-size="12" text-anchor="${right?'end':'start'}" fill="var(--ink)" font-family="var(--body)" font-weight="600" stroke="var(--surface)" stroke-width="5" paint-order="stroke" stroke-linejoin="round">${esc(t)}</text>`; }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe d'évaluation de la partie">${s}</svg>`;
}
function renderReport(r){
  const root = $('report'); root.innerHTML = ''; const m = r.meta, o = m.color;
  const me = o === 'w' ? 'Blancs' : 'Noirs';
  const head = document.createElement('header'); head.className = 'rh';
  const themesFound = [...new Set([...(r.bad||[]), ...(r.timing||[]), ...(r.good||[])].map(it => it.work).filter(w => WORK[w]))];
  head.innerHTML = `<div class="eyebrow">Analyse de partie · tu joues les ${me}</div>
    <h1>${esc(m.white)}${m.whiteElo?` (${esc(m.whiteElo)})`:''} – ${esc(m.black)}${m.blackElo?` (${esc(m.blackElo)})`:''}</h1>
    <div class="meta">${[m.date, m.tc, m.opening, [m.result, m.end].filter(Boolean).join(' · '), reportAcc(r) != null ? `précision ${reportAcc(r)}%` : ''].filter(Boolean).map(x=>`<span>${esc(x)}</span>`).join('')}</div>
    ${r.notice ? `<p class="notice">${esc(r.notice)}</p>` : ''}
    ${themesFound.length ? `<div class="meta"><span class="eyebrow" style="background:none;padding:0">Thèmes de cette partie (aussi dans ton radar) :</span>${themesFound.map(w => `<span class="tag">${esc(workLabel(w))}</span>`).join('')}</div>` : ''}
    <p class="lede"><b>Comment lire :</b> les erreurs sont repérées objectivement par le moteur Stockfish (profondeur 13, il compare ton coup au meilleur coup et mesure la perte en pions). L'IA ne fait qu'expliquer et classer par thème les coups déjà sélectionnés par le moteur — elle n'a pas le droit de citer des coups absents des variantes. Échiquiers vus de ton côté ; « variante » = suite proposée par le moteur, non jouée ; +1 ≈ un pion d'avance.</p>
    <div class="curve"><div class="eyebrow" style="margin-bottom:6px">Qui était mieux, coup par coup (vers le haut = avantage pour toi)</div>${curveSVG(r)}</div>`;
  root.append(head);
  const section = (eyebrow, title, sub, items, build) => { if (!items || !items.length) return;
    const s = document.createElement('section'); s.className = 'stack cases';
    s.innerHTML = `<div class="sec-head"><div class="eyebrow">${eyebrow}</div><h2>${title}</h2>${sub?`<p>${sub}</p>`:''}</div>`;
    items.forEach(it => s.append(build(it))); root.append(s); };
  section('Partie 1', 'Les 3 choses que tu as bien faites', 'Une par domaine quand c\'est possible : ouverture, stratégie, tactique.', r.good, it => {
    const c = document.createElement('article'); c.className = 'case';
    c.innerHTML = `<div class="case-head"><span class="tag good">${esc(it.tag)}</span><h3>${esc(it.title)}</h3>${it.work && WORK[it.work] ? `<span class="themechip">Thème : ${esc(workLabel(it.work))}</span>` : ''}</div><div class="solo"></div>`;
    const solo = c.querySelector('.solo'); solo.append(viewer(it.line, o, {kind:'game'})); solo.insertAdjacentHTML('beforeend', analysisHTML(it.analysis, it.rule)); return c; });
  const duo = (it, tagcls) => { const c = document.createElement('article'); c.className = 'case';
    c.innerHTML = `<div class="case-head"><span class="tag ${tagcls}">${esc(it.tag)}</span><h3>${esc(it.title)}</h3>${it.work && WORK[it.work] ? `<span class="themechip">Thème : ${esc(workLabel(it.work))}</span>` : ''}</div><div class="duo"></div>`;
    const d = c.querySelector('.duo');
    d.append(viewer(it.played.frames, o, {kind:'played', title: it.played.title, eval: it.played.eval}));
    d.append(viewer(it.best.frames, o, {kind:'best', title: it.best.title, eval: it.best.eval}));
    if (it.alt) d.append(viewer(it.alt.frames, o, {kind:'alt', title: it.alt.title}));
    c.insertAdjacentHTML('beforeend', analysisHTML(it.analysis, it.rule)); return c; };
  section('Partie 2', 'Les 3 choses à changer pour être encore meilleur', 'À gauche ce que tu as joué dans la partie, à droite ce que proposait le moteur. Fais défiler les deux pour comparer où chaque suite mène.', r.bad, it => duo(it, 'bad'));
  section('Partie 3', 'Pu faire, plus vite, trop vite', 'Des questions de timing : un coup que tu avais sous la main, une idée que tu as eue trop tard, un coup joué avant d\'être prêt.', r.timing, it => duo(it, ''));
}

/* ---------- PGN ---------- */
function parsePGN(text){
  const headers = {}; text.replace(/\[(\w+)\s+"([^"]*)"\]/g, (_, k, v) => { headers[k] = v; return ''; });
  let body = text.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  let prev; do { prev = body; body = body.replace(/\([^()]*\)/g, ' '); } while (body !== prev);
  const toks = body.replace(/\$\d+/g, ' ').replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/).filter(t => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
  const g = new Chess(); if (headers.FEN) g.load(headers.FEN);
  const moves = [];
  for (const t of toks){ const clean = t.replace(/[!?]+$/, ''); const m = g.move(clean, {sloppy:true});
    if (!m) throw new Error(`Je n'arrive pas à lire le coup « ${t} ». Vérifie que tu as collé tout le PGN.`); moves.push(m); }
  if (moves.length < 6) throw new Error('La partie est trop courte ou le PGN est incomplet.');
  return {headers, moves, startFen: headers.FEN || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'};
}

/* ---------- engine ---------- */
function makeEngine(){
  return new Promise((resolve, reject) => {
    let w; try { w = new Worker(ENGINE_URL); }
    catch (e) { reject(new Error('Le moteur n\'a pas pu démarrer dans ce navigateur.')); return; }
    let listener = null; const t = setTimeout(() => reject(new Error('Le moteur met trop de temps à charger. Recharge la page et réessaie.')), 45000);
    w.onerror = () => { clearTimeout(t); reject(new Error('Le moteur n\'a pas pu se charger (connexion ou blocage du navigateur).')); };
    w.onmessage = e => { const line = String(e.data); if (listener) listener(line); };
    listener = line => { if (line === 'uciok'){ w.postMessage('setoption name MultiPV value 2'); w.postMessage('isready'); }
      if (line === 'readyok'){ clearTimeout(t); resolve({ analyse, quit: () => { try { w.terminate(); } catch {} } }); } };
    w.postMessage('uci');
    function analyse(fen, depth){
      return new Promise(res => { const lines = {};
        listener = line => {
          if (line.startsWith('info') && line.includes(' pv ') && line.includes(' score ')){
            const mpv = +(line.match(/ multipv (\d+)/)||[0,1])[1];
            const sc = line.match(/ score (cp|mate) (-?\d+)/); const pv = line.split(' pv ')[1].trim().split(' ');
            let v = +sc[2]; if (sc[1] === 'mate') v = v > 0 ? 10000 - v : -10000 - v;
            lines[mpv] = {score: v, pv};
          } else if (line.startsWith('bestmove')){ listener = null; res(lines); }
        };
        w.postMessage('position fen ' + fen); w.postMessage('go depth ' + depth);
      });
    }
  });
}

/* ---------- lines ---------- */
function frameLabel(g, m){ const parts = g.fen().split(' '); const num = +parts[5]; return m.color === 'w' ? `${num}.${m.san}` : `${m.color === 'b' && parts[1] === 'w' ? num-1 : num}...${m.san}`; }
function buildFrames(fen, moveList){
  const g = new Chess(fen); const frames = [{fen: g.fen().split(' ')[0], san: 'Position', note: ''}];
  for (const mv of moveList){
    const beforeNum = +g.fen().split(' ')[5], turn = g.turn();
    const m = typeof mv === 'string' && /^[a-h][1-8][a-h][1-8]/.test(mv) ? g.move({from: mv.slice(0,2), to: mv.slice(2,4), promotion: mv[4] || 'q'}) : g.move(mv, {sloppy:true});
    if (!m) break;
    frames.push({fen: g.fen().split(' ')[0], san: turn === 'w' ? `${beforeNum}.${m.san}` : `${beforeNum}...${m.san}`, from: m.from, to: m.to, note: ''});
  }
  return frames;
}
const moveNo = (idx, startTurn) => { const n = Math.floor(idx/2) + 1; return idx % 2 === 0 ? `${n}.` : `${n}...`; };

/* ---------- pipeline ---------- */
let sampleFn = null, db = null, busy = false;
function status(t, frac){ $('status').hidden = false; $('stxt').textContent = t; if (frac != null) $('sbar').style.width = Math.round(frac*100) + '%'; }
function fail(msg){ $('err').hidden = false; $('err').textContent = msg; $('status').hidden = true; }

let _enginePromise = null;
const getEngine = () => (_enginePromise ||= makeEngine().catch(e => { _enginePromise = null; throw e; }));

async function analysePgn(txt, user, onStatus, engine){
  const game = parsePGN(txt);
  const H = game.headers; let color = null;
  if (user && (H.Black||'').toLowerCase() === user.toLowerCase()) color = 'b';
  else if (user && (H.White||'').toLowerCase() === user.toLowerCase()) color = 'w';
  if (!color) throw new Error(`Je ne trouve pas « ${user} » dans les joueurs de cette partie (${H.White||'?'} – ${H.Black||'?'}). Corrige ton pseudo.`);
  {
    onStatus('Chargement du moteur…', 0.02);
    const eng = engine || await getEngine();
    const g = new Chess(game.startFen); const fens = [g.fen()];
    for (const m of game.moves){ g.move(m.san); fens.push(g.fen()); }
    const infos = [];
    for (let i=0; i<fens.length; i++){
      onStatus(`Le moteur analyse les coups… ${i}/${fens.length-1}`, 0.05 + 0.75*i/fens.length);
      const chk = new Chess(fens[i]);
      if (chk.game_over()){ const mate = chk.in_checkmate(); const stm = chk.turn(); infos.push({w: mate ? (stm==='w' ? -10000 : 10000) : 0, lines:{}}); continue; }
      const lines = await eng.analyse(fens[i], 13);
      const stmSign = fens[i].split(' ')[1] === 'w' ? 1 : -1;
      infos.push({w: (lines[1]?.score ?? 0) * stmSign, lines});
    }
    const cap = v => Math.max(-1000, Math.min(1000, v));
    const sign = color === 'w' ? 1 : -1;
    const evals = infos.map(x => cap(x.w));
    const pov = i => sign * evals[i] / 100;
    const mine = [], opp = [];
    game.moves.forEach((m, i) => {
      const info = infos[i]; const best = info.lines[1]?.pv?.[0]; const uci = m.from + m.to + (m.promotion || '');
      const before = pov(i), after = pov(i+1); const loss = +(before - after).toFixed(2);
      const s1 = info.lines[1]?.score, s2 = info.lines[2]?.score; const gap = (s1 != null && s2 != null) ? (s1 - s2)/100 : 0;
      const rec = {i, no: moveNo(i) , san: m.san, piece: m.piece, to: m.to, uci, best, matched: best === uci, before, after, loss, gap, pv: info.lines[1]?.pv || []};
      (m.color === color ? mine : opp).push(rec);
    });
    const bestSan = rec => { const t = new Chess(fens[rec.i]); const mm = rec.best ? t.move({from: rec.best.slice(0,2), to: rec.best.slice(2,4), promotion: rec.best[4]||'q'}) : null; return mm ? mm.san : '?'; };
    const pvSans = (rec, n) => buildFrames(fens[rec.i], rec.pv.slice(0, n)).slice(1).map(f => f.san);
    const gameSans = (i, n) => game.moves.slice(i, i+n).map((m, k) => moveNo(i+k) + m.san);
    const decided = r => (r.before > 5 && r.after > 5) || (r.before < -5 && r.after < -5);
    const mistakes = mine.filter(r => r.loss >= 0.5 && !decided(r)).sort((a,b) => b.loss - a.loss).slice(0, 8);
    let goods = mine.filter(r => r.matched && r.gap >= 0.6).sort((a,b) => b.gap - a.gap).slice(0, 8);
    if (goods.length < 3) goods = goods.concat(mine.filter(r => r.matched && !goods.includes(r)).sort((a,b) => b.gap - a.gap).slice(0, 6 - goods.length));
    mistakes.forEach(r => {
      r.bestSan = bestSan(r);
      const bt = new Chess(fens[r.i]); const bm = r.best ? bt.move({from: r.best.slice(0,2), to: r.best.slice(2,4), promotion: r.best[4]||'q'}) : null;
      const later = bm ? mine.find(x => x.i > r.i && x.i <= r.i + 24 && x.piece === bm.piece && x.to === bm.to) : null;
      if (later) r.idea_played_later = later.no + later.san;
      const inPv = r.pv.slice(2).findIndex((u, k) => k % 2 === 0 && u.slice(2,4) === r.to);
      if (inPv >= 0) r.played_move_appears_later_in_engine_line = true;
    });
    const mk = (r, n, kind) => ({id: r.id, move: r.no + r.san, loss_pawns: r.loss, eval_before: +r.before.toFixed(1), eval_after: +r.after.toFixed(1),
      engine_best: r.bestSan, engine_line: kind === 'bad' ? pvSans(r, 6) : undefined, game_continuation: gameSans(r.i, n), fen_before: fens[r.i],
      idea_played_later: r.idea_played_later, played_move_appears_later_in_engine_line: r.played_move_appears_later_in_engine_line});
    mistakes.forEach((r, k) => r.id = 'm' + (k+1)); goods.forEach((r, k) => r.id = 'g' + (k+1));
    const candBad = mistakes.map(r => mk(r, 6, 'bad'));
    const candGood = goods.map(r => ({id: r.id, move: r.no + r.san, only_move_margin_pawns: +r.gap.toFixed(1), eval_after: +r.after.toFixed(1), game_continuation: gameSans(r.i, 6), fen_before: fens[r.i]}));
    const gameText = game.moves.map((m, i) => (i % 2 === 0 ? `${Math.floor(i/2)+1}. ` : '') + m.san).join(' ');

    // frames
    const lineGame = (r, n) => { const fr = buildFrames(fens[r.i], game.moves.slice(r.i, r.i+n).map(m => m.san)); return fr; };
    const lineBest = r => buildFrames(fens[r.i], r.pv.slice(0, 6));
    const byId = {}; mistakes.forEach(r => byId[r.id] = r); goods.forEach(r => byId[r.id] = r);

    let ai = null; let notice = '';
    if (sampleFn){
      onStatus('L\'IA écrit les explications… (30 s à 2 min)', 0.85);
      const prompt = buildPrompt({H, color, gameText, candGood, candBad, lenGame: id => Math.min(6, game.moves.length - byId[id].i) + 1, lenBest: id => lineBest(byId[id]).length});
      try { ai = await sampleFn.json(prompt, {modelTier: 'default'}); }
      catch (e) { notice = e.code === 'no_key' ? 'Explications détaillées indisponibles : ajoute une clé IA (Gemini ou Anthropic) dans l\'onglet Réglages. Les échiquiers et évaluations du moteur sont bien là.' : 'L\'IA n\'a pas pu écrire les explications cette fois (' + (e.message || 'erreur') + '). Les échiquiers et évaluations du moteur sont bien là ; tu peux relancer l\'analyse.'; }
    } else notice = 'Explications détaillées indisponibles : ajoute une clé IA (Gemini ou Anthropic) dans l\'onglet Réglages. Les échiquiers et évaluations du moteur sont bien là.';

    const fill = (frames, notes) => { frames.forEach((f, k) => f.note = (Array.isArray(notes) && typeof notes[k] === 'string' && notes[k]) ? notes[k] : (k === 0 ? 'Position avant le coup.' : f.san)); return frames; };
    const pickIds = (arr, pool, n) => { const out = []; for (const x of (arr||[])){ if (x && byId[x.id] && pool.includes(byId[x.id]) && !out.find(o => o.id === x.id)) out.push(x); } return out.slice(0, n); };
    let goodSel = pickIds(ai?.good, goods, 3), badSel = pickIds(ai?.bad, mistakes, 3);
    if (goodSel.length === 0) goodSel = goods.slice(0,3).map(r => ({id: r.id}));
    if (badSel.length === 0) badSel = mistakes.slice(0,3).map(r => ({id: r.id}));
    const used = new Set(badSel.map(x => x.id));
    let timingSel = pickIds(ai?.timing, mistakes, 3).filter(x => !used.has(x.id));
    const KIND = {could: 'Ce que tu aurais pu faire', faster: 'Ce que tu aurais dû faire plus vite', early: 'Ce que tu as fait trop vite'};
    const report = {
      meta: {white: H.White || 'Blancs', whiteElo: H.WhiteElo || '', black: H.Black || 'Noirs', blackElo: H.BlackElo || '',
             date: (H.Date || '').split('.').reverse().join('.'), tc: fmtTC(H.TimeControl), opening: fmtOpening(H), result: H.Result || '', end: H.Termination || '', color,
             accuracy: accFromEvals(evals, color), oppAccuracy: accFromEvals(evals, color === 'w' ? 'b' : 'w')},
      evals, notice,
      marks: badSel.slice(0,3).map(x => [byId[x.id].i + 1, byId[x.id].no + byId[x.id].san]).concat(opp.filter(r => r.loss >= 2 && !decided(r)).sort((a,b)=>b.loss-a.loss).slice(0,1).map(r => [r.i+1, r.no + r.san + '??'])),
      good: goodSel.map(x => { const r = byId[x.id]; return {work: WORK[x.work] ? x.work : undefined, tag: x.tag || `Coup ${r.no}${r.san}`, title: x.title || `${r.no}${r.san} : le meilleur coup`, line: fill(lineGame(r, 6), x.notes), analysis: x.analysis || [{p: `C'était le premier choix du moteur${r.gap >= 0.6 ? `, et les autres coups étaient nettement moins bons (écart ${fmtEval(r.gap)})` : ''}.`}], rule: x.rule || ''}; }),
      bad: badSel.map(x => dual(x, byId[x.id], x.tag || `Coup ${byId[x.id].no}${byId[x.id].san}`)),
      timing: timingSel.filter(x => KIND[x.kind]).map(x => dual(x, byId[x.id], `${KIND[x.kind]} · coup ${byId[x.id].no.replace(/\.+$/, '')}`)),
    };
    function dual(x, r, tag){ return {work: WORK[x.work] ? x.work : undefined, tag, title: x.title || `${r.no}${r.san} : le moteur préférait ${r.bestSan}`,
      played: {title: `Tu as joué ${r.no}${r.san}`, eval: fmtEval(r.after), frames: fill(lineGame(r, 6), x.notes_played)},
      best: {title: `Il fallait ${r.no}${r.bestSan}`, eval: fmtEval(r.before), frames: fill(lineBest(r), x.notes_best)},
      analysis: x.analysis || [{p: `Ce coup t'a coûté environ ${fmtEval(r.loss).replace('+','')} pion. Le moteur préférait ${r.bestSan}.`}], rule: x.rule || ''}; }
    return report;
  }
}

async function analyseGame(){
  if (busy) return; $('err').hidden = true;
  const txt = $('pgn').value.trim(); if (!txt){ fail('Colle d\'abord le PGN de ta partie dans la zone ci-dessus.'); return; }
  const user = $('user').value.trim(); settings.ccUser = user; saveSettings(settings); const su = $('s-ccuser'); if (su) su.value = user;
  busy = true; $('go').disabled = true;
  try {
    const report = await analysePgn(txt, user, status);
    renderReport(report); $('report').scrollIntoView({behavior: 'smooth', block: 'start'});
    status('Analyse terminée.', 1);
    await saveReport(report);
  } catch (e) { fail(e.message || 'L\'analyse a échoué. Réessaie.'); }
  finally { busy = false; $('go').disabled = false; }
}
function fmtTC(tc){ if (!tc) return ''; const [b, inc] = tc.split('+'); const min = Math.round(+b/60); return `${min} min${inc ? ` + ${inc} s` : ''}`; }
function fmtOpening(H){ const slug = (H.ECOUrl || '').split('/').pop(); const name = slug ? decodeURIComponent(slug).replace(/-/g, ' ') : ''; return [name, H.ECO].filter(Boolean).join(' · '); }

function buildPrompt({H, color, gameText, candGood, candBad, lenGame, lenBest}){
  const goodSpec = candGood.map(c => ({...c, notes_count: lenGame(c.id)}));
  const badSpec = candBad.map(c => ({...c, notes_played_count: lenGame(c.id), notes_best_count: lenBest(c.id)}));
  return `Tu es un coach d'échecs bienveillant mais direct. Tu analyses la partie d'un joueur débutant (environ ${color === 'w' ? H.WhiteElo : H.BlackElo || '600'} Elo) qui joue les ${color === 'w' ? 'Blancs' : 'Noirs'}. Écris en français, tutoiement, phrases courtes, mots simples.

PARTIE : ${gameText}

Les évaluations sont du point de vue du joueur, en pions (+1 = un pion d'avance pour lui).

CANDIDATS "bons coups" (coups du joueur qui étaient le premier choix du moteur) :
${JSON.stringify(goodSpec)}

CANDIDATS "erreurs" (coups du joueur qui ont perdu de l'évaluation). engine_line commence par le meilleur coup ; game_continuation commence par le coup joué :
${JSON.stringify(badSpec)}

TA TÂCHE
1. "good" : choisis les 3 meilleurs bons coups, idéalement un d'ouverture, un de stratégie, un de tactique.
2. "bad" : choisis les 3 erreurs les plus instructives (pas forcément les plus coûteuses).
3. "timing" : 0 à 3 éléments parmi les erreurs NON choisies en 2, chacun avec "kind" :
   - "could" = un coup fort que le joueur avait sous la main ;
   - "faster" = seulement si idea_played_later est renseigné (le joueur a joué l'idée plus tard) ;
   - "early" = seulement si played_move_appears_later_in_engine_line est true (bon coup, mais joué trop tôt).
   N'invente pas de catégorie si les données ne la justifient pas.

Pour chaque élément :
- "id" : l'id du candidat.
- "tag" : domaine + coup, ex. "Ouverture · coup 8" (pour timing, mets juste le domaine).
- "title" : une phrase courte qui dit ce qui s'est passé.
- good : "notes" = exactement notes_count phrases. La note 0 décrit la position de départ (avant le coup), la note k décrit le k-ième coup de game_continuation.
- bad et timing : "notes_played" = exactement notes_played_count phrases pour la suite game_continuation (note 0 = position de départ) ; "notes_best" = exactement notes_best_count phrases pour engine_line (note 0 = position de départ).
- "analysis" : liste de blocs {"h": "sous-titre"} | {"p": "paragraphe"} | {"ul": ["puce", ...]}. Pour une erreur : pourquoi le coup du moteur est meilleur (conséquence concrète dans la suite), puis ce que chaque option donne comme structure / position. 2 à 4 blocs. Tu peux mettre un mot en gras avec **mot**.
- "rule" : une règle courte et mémorisable à retenir.
- "work" : le thème d'entraînement qui correspond le mieux, choisi dans cette liste (clé exacte) : ${Object.entries(WORK).filter(([k]) => k !== 'mixed').map(([k,v]) => `${k} = ${v.l}`).join(' ; ')}.

RÈGLES STRICTES
- Ne cite QUE des coups présents dans game_continuation, engine_line ou la PARTIE. N'invente aucun coup.
- game_continuation = ce qui s'est vraiment joué. engine_line = une variante du moteur qui n'a PAS eu lieu : présente-la comme « le moteur propose… », jamais comme un coup joué.
- Utilise fen_before pour savoir où sont les pièces. Si tu n'es pas sûr d'une explication tactique, reste simple et ne l'affirme pas.
- Chaque note fait au maximum 25 mots.

Réponds uniquement avec ce JSON :
{"good":[{"id":"g1","work":"","tag":"","title":"","notes":[],"analysis":[],"rule":""}],"bad":[{"id":"m1","work":"","tag":"","title":"","notes_played":[],"notes_best":[],"analysis":[],"rule":""}],"timing":[{"id":"m4","kind":"could","work":"","tag":"","title":"","notes_played":[],"notes_best":[],"analysis":[],"rule":""}]}`;
}

/* ---------- history (db) ---------- */
let history = [], current = 'example';
// clé de tri = date de la partie (meta.date "JJ.MM.AAAA") en AAAAMMJJ, sinon date d'enregistrement
const dateKey = d => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d.report?.meta?.date || ''); return m ? +(m[3] + m[2] + m[1]) : (d.createdAt || 0); };
// précision (méthode Lichess/Chess.com) : centipions → % de victoire → précision par coup, moyennée.
// meta.accuracy si présent, sinon recalculée depuis la courbe d'éval stockée (report.evals, point de vue Blancs).
const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
function accFromEvals(evals, color){
  if (!Array.isArray(evals) || evals.length < 2) return null;
  const sign = color === 'w' ? 1 : -1, cap = v => Math.max(-1000, Math.min(1000, v));
  const accs = [];
  for (let i = 0; i < evals.length - 1; i++){ const mine = color === 'w' ? i % 2 === 0 : i % 2 === 1; if (!mine) continue;
    const d = Math.max(0, winPct(sign * cap(evals[i])) - winPct(sign * cap(evals[i + 1])));
    accs.push(Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * d) - 3.1669))); }
  return accs.length ? Math.round(accs.reduce((a, b) => a + b, 0) / accs.length) : null;
}
const reportAcc = rep => rep?.meta?.accuracy ?? accFromEvals(rep?.evals, rep?.meta?.color);
const myResult = m => { if (!m.result || m.result === '*') return '?'; if (m.result === '1/2-1/2') return 'N'; const meWhite = m.color === 'w'; return (m.result === '1-0') === meWhite ? 'V' : 'D'; };
const myElo = m => m.color === 'w' ? m.whiteElo : m.blackElo;
const oppElo = m => m.color === 'w' ? m.blackElo : m.whiteElo;
const oppName = m => m.color === 'w' ? m.black : m.white;
const optLabel = d => { const m = d.report?.meta; if (!m) return d.label || 'Analyse';
  const a = reportAcc(d.report); const acc = a != null ? ` · ${a}%` : '';
  const elos = (myElo(m) || oppElo(m)) ? ` · ${myElo(m) || '?'} vs ${oppElo(m) || '?'}` : '';
  const r = myResult(m); const dot = r === 'V' ? '🟢' : r === 'D' ? '🔴' : '⚪';
  return `${dot} ${m.date || '?'} · ${r}${acc}${elos} · ${oppName(m) || '?'}`; };
function renderHistory(){
  const sel = $('history-sel');
  const opts = [...history].sort((a, b) => dateKey(b) - dateKey(a))
    .map(d => `<option value="${esc(d.id)}"${current === d.id ? ' selected' : ''}>${esc(optLabel(d))}</option>`);
  if (EXAMPLE) opts.push(`<option value="example"${current === 'example' ? ' selected' : ''}>Exemple · partie commentée</option>`);
  sel.innerHTML = opts.length ? opts.join('') : '<option value="" disabled selected>Aucune analyse pour l\'instant</option>';
  renderProgress(); renderDash();
}
function openAnalysis(id){ current = id; if (id === 'example') renderReport(EXAMPLE); else { const d = history.find(x => x.id === id); if (!d) return; renderReport(d.report); }
  renderHistory(); selectTab('analyses'); $('report').scrollIntoView({block:'start'}); }
$('history-sel').addEventListener('change', e => { if (e.target.value) openAnalysis(e.target.value); });

/* ---------- progress ---------- */
let sessions = [], showAllCmp = false, cmpRows = [];
$('cmp').addEventListener('click', e => { if (e.target.closest('[data-cmp-toggle]')){ showAllCmp = !showAllCmp; renderProgress(); } });
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
function allAnalyses(){
  const list = history.map(d => ({id: d.id, label: d.label, report: d.report}));
  if (!EXAMPLE) return list;
  const m = EXAMPLE.meta; const dup = list.some(d => d.report?.meta && d.report.meta.white === m.white && d.report.meta.black === m.black && d.report.meta.date === m.date);
  if (!dup) list.push({id: 'example', label: `${m.white} – ${m.black} · ${m.date}`, report: EXAMPLE});
  return list;
}
function pct(x){ return Math.round(x*100) + ' %'; }
function hbar(share, cssVar, text, tip){ return `<div class="hb" title="${esc(tip)}"><span class="track"><span class="fill" style="width:${Math.round(Math.min(1,share)*100)}%;background:var(${cssVar})"></span></span><span class="v">${esc(text)}</span></div>`; }
const trendBadge = t => !t || t.dir == null ? '' :
  t.dir === 'down' ? `<span class="trend good" title="Moins d'erreurs sur la période récente que sur la précédente (${Math.abs(t.pct)}% de moins) : tu progresses">▲ progrès</span>` :
  t.dir === 'up' ? `<span class="trend bad" title="Plus d'erreurs récemment (+${t.pct}%) : à surveiller">▼ en recul</span>` :
  `<span class="trend flat" title="Stable d'une période à l'autre">= stable</span>`;
function renderProgress(){
  const {need, lp, lw, trend, lpTotal} = themeStats();
  const needTotal = Object.values(need).reduce((a, b) => a + b, 0);
  const lpBase = Object.values(lp).reduce((a, b) => a + b, 0);
  const keys = [...new Set([...Object.keys(need), ...Object.keys(lp).filter(k => k !== 'mixed')])];
  const rows = keys.map(k => { const n = need[k] || 0, p = lp[k] || 0;
    return {k, ns: needTotal ? n / needTotal : 0, ps: lpBase ? p / lpBase : 0, n, p, v: themeVerdict(n, p), tr: trend[k]}; })
    .sort((a, b) => (b.ns - a.ns) || (b.ps - a.ps));
  cmpRows = rows;
  const link = k => { const w = WORK[k]; if (!w) return ''; if (w.s) return `<a href="https://lichess.org/training/${w.s}" target="_blank" rel="noopener">Puzzles ↗</a>`; if (w.url) return `<a href="${w.url}" target="_blank" rel="noopener">${w.url.includes('chessbook') ? 'Chessbook' : w.url.includes('practice') ? 'Leçons Lichess' : 'Leçons'} ↗</a>`; return '<span class="muted" style="font-size:13px">—</span>'; };
  const trackable = k => !!WORK[k]?.s; // seulement les thèmes tactiques ont des puzzles Lichess
  const blueBar = r => trackable(r.k)
    ? hbar(r.ps, '--time', pct(r.ps), lp[r.k] ? `${pct(r.ps)} de tes puzzles Lichess (${lp[r.k]} puzzles, ${lw[r.k]||0} réussis)` : 'Aucun puzzle Lichess sur ce thème')
    : `<div class="hb" title="Thème stratégique : pas de puzzles Lichess. Ta progression se lit sur l'indicateur ▲/▼ (baisse de tes erreurs au fil des parties)."><span class="v" style="color:var(--muted)">non suivi</span></div>`;
  const row = r => `<tr>
      <td><div class="theme-name" title="${esc(WORK[r.k]?.k || '')} — ${esc(r.v[1])}">${esc(workLabel(r.k))}</div>${trendBadge(r.tr)}</td>
      <td><div class="dbars">
        ${hbar(r.ns, '--need', pct(r.ns), `${pct(r.ns)} de tes erreurs en partie (${String(+r.n.toFixed(1)).replace('.', ',')} pondérées) — ${r.v[1]}`)}
        ${blueBar(r)}
      </div></td>
      <td>${link(r.k)}</td></tr>`;
  const shown = showAllCmp ? rows : rows.slice(0, 8);
  $('cmp').innerHTML = rows.length ? shown.map(row).join('') +
      (rows.length > 8 ? `<tr><td colspan="3" style="border-bottom:0;padding-top:6px"><button type="button" class="btn ghost sm" data-cmp-toggle>${showAllCmp ? 'Réduire' : `Tout afficher (${rows.length})`}</button></td></tr>` : '')
    : `<tr><td colspan="3" class="muted">Analyse tes parties pour voir apparaître tes thèmes.</td></tr>`;
  const plab = period === 'all' ? 'toutes périodes' : '30 jours';
  $('cmpnote').textContent = `Sur ${plab} · ${lpTotal} puzzle${lpTotal>1?'s':''} Lichess. « progrès / en recul » compare tes erreurs sur ce thème entre la moitié récente et la moitié ancienne de tes parties analysées.`;
  const prio = rows.filter(r => r.v[0] === 'prio').slice(0, 2);
  const improving = rows.filter(r => r.tr?.dir === 'down').slice(0, 1);
  let h = '';
  if (prio.length){ h = `Priorité : <b>${esc(workLabel(prio[0].k))}</b>${prio[1] ? ` puis <b>${esc(workLabel(prio[1].k))}</b>` : ''} — ça revient dans tes parties et tu t'y entraînes peu.`;
    if (improving.length) h += ` Bon point : tu progresses sur <b>${esc(workLabel(improving[0].k))}</b>.`; }
  else if (rows.length) h = `Ton entraînement suit bien tes erreurs.${improving.length ? ` Tu progresses notamment sur <b>${esc(workLabel(improving[0].k))}</b>.` : ''} Continue et analyse de nouvelles parties pour affiner.`;
  else h = 'Analyse tes parties récentes pour construire ton diagnostic.';
  $('headline').innerHTML = h;
}
function selectTab(name){ for (const n of ['dash','analyses','settings']){ const on = n === name; $('t-'+n).setAttribute('aria-selected', on); $('p-'+n).hidden = !on; }
  if (name === 'dash'){ renderDash(); if (!ccGames && db && !ccLoading && ($('user').value || '').trim()) loadCcGames(); } }
$('t-dash').onclick = () => selectTab('dash'); $('t-analyses').onclick = () => selectTab('analyses'); $('t-settings').onclick = () => selectTab('settings');
if (location.hash === '#analyses') selectTab('analyses');
async function saveReport(report){
  const label = `${report.meta.white} – ${report.meta.black} · ${report.meta.date || ''}`.trim();
  const ref = dbAdd('analyses', {createdAt: Date.now(), label, report});
  current = ref.id; loadAnalyses();
  if (!ref.ok){ $('err').hidden = false; $('err').textContent = 'Stockage du navigateur plein : la plus ancienne analyse a été retirée pour faire de la place. Pense à exporter tes données (Réglages).'; }
}

/* ---------- chargement des données locales ---------- */
function loadAnalyses(){ history = dbList('analyses'); renderHistory(); }
function loadSessions(){ sessions = dbList('sessions'); renderProgress(); }
function loadPuzzles(){ liEntries = (dbGet('puzzles_lichess') || {}).entries || []; renderProgress(); renderDash(); }
$('cc-import').addEventListener('click', async () => {
  if (busy || batch) return;
  const err = $('err'); err.hidden = true; const info = $('cc-import-info');
  const user = $('user').value.trim();
  if (!user){ fail('Indique ton pseudo Chess.com.'); return; }
  settings.ccUser = user; saveSettings(settings); const su = $('s-ccuser'); if (su) su.value = user;
  $('cc-import').disabled = true; info.textContent = 'Récupération de tes parties…';
  try {
    if (!ccGames) await loadCcGames(true);
    const missing = (ccGames || []).filter(g => !analysisFor(g.pgn));
    if (!missing.length){ info.textContent = 'Tout est déjà analysé ✓'; return; }
    info.textContent = `${missing.length} nouvelle${missing.length > 1 ? 's' : ''} partie${missing.length > 1 ? 's' : ''} à analyser…`;
    selectTab('dash'); window.scrollTo({top: 0, behavior: 'smooth'});
    await runBatch();
    info.textContent = '';
  } catch (e) { fail(e.message); }
  finally { $('cc-import').disabled = false; }
});

/* ---------- tableau de bord ---------- */
let ccGames = null, ccLoading = false, ccStats = null;
async function loadCcStats(){
  const user = $('user').value.trim(); if (!user) return;
  try { ccStats = await ccPlayerStats(user); renderDash(); } catch {}
}
const TC_FR = {rapid: 'rapide', blitz: 'blitz', bullet: 'bullet', daily: 'quotidienne'};
const pgnHeaders = pgn => { const H = {}; for (const m of pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) H[m[1]] = m[2]; return H; };
const gameKey = H => `${(H.White||'').toLowerCase()}|${(H.Black||'').toLowerCase()}|${(H.Date||'').split('.').reverse().join('.')}`;
function analysisFor(pgn){ const k = gameKey(pgnHeaders(pgn));
  return history.find(d => { const m = d.report?.meta; return m && `${(m.white||'').toLowerCase()}|${(m.black||'').toLowerCase()}|${m.date||''}` === k; }); }

async function loadCcGames(force){
  if (ccLoading) return; const user = $('user').value.trim();
  if (!user){ $('dash-err').hidden = false; $('dash-err').textContent = 'Indique ton pseudo Chess.com dans l\'onglet Analyses.'; return; }
  ccLoading = true; $('dash-err').hidden = true;
  if (force || !ccGames) $('dash-games').innerHTML = '<span class="muted" style="font-size:14px">Chargement des parties Chess.com…</span>';
  $('dash-refresh').disabled = true;
  try { ccGames = await ccRecentGames(user); renderDash(); }
  catch (e) { $('dash-err').hidden = false; $('dash-err').textContent = e.message; $('dash-games').innerHTML = ''; }
  finally { ccLoading = false; $('dash-refresh').disabled = false; }
}

const themeVerdict = (n, p) => n === 0 ? ['ok', 'Pas d\'erreur récente'] : p === 0 ? ['prio', 'Pas encore travaillé'] : (n >= 1.5 && p < 15) ? ['prio', 'À travailler plus'] : ['ok', 'En cours'];
let selTheme = null, themeCache = null, period = '30j'; // '30j' | 'all'

function themeStats(){
  const days = 30, sinceMs = period === 'all' ? 0 : Date.now() - days*864e5;
  const c = new Date(Date.now() - days*864e5);
  const cutoffKey = period === 'all' ? 0 : +(`${c.getFullYear()}${String(c.getMonth()+1).padStart(2,'0')}${String(c.getDate()).padStart(2,'0')}`);
  const need = {}, moments = {}, occ = {}; const gameList = [];
  for (const a of allAnalyses()){ const r = a.report || {}; if (dateKey(a) < cutoffKey) continue;
    const perTheme = {}; // erreurs pondérées par thème pour CETTE partie (pour la tendance)
    for (const it of (r.good || [])){ const k = WORK[it.work] ? it.work : null; if (!k) continue;
      (occ[k] = occ[k] || []).push({id: a.id, label: a.label, title: it.title, dk: dateKey(a), date: r.meta?.date || '', kind: 'good'}); }
    for (const [arr, wt] of [[r.bad, 1], [r.timing, 0.6]]) for (const it of (arr || [])){
      const k = WORK[it.work] ? it.work : null; if (!k) continue;
      need[k] = (need[k] || 0) + wt; perTheme[k] = (perTheme[k] || 0) + wt;
      const m = {id: a.id, label: a.label, title: it.title, dk: dateKey(a), date: r.meta?.date || '', kind: 'bad'};
      (moments[k] = moments[k] || []).push(m); (occ[k] = occ[k] || []).push(m); }
    gameList.push({dk: dateKey(a), perTheme}); }
  // tendance : erreurs/partie sur la moitié récente vs la moitié ancienne des parties analysées
  gameList.sort((a, b) => a.dk - b.dk);
  const trend = {};
  if (gameList.length >= 4){
    const mid = Math.floor(gameList.length / 2);
    const older = gameList.slice(0, mid), recent = gameList.slice(mid);
    const rate = (arr, k) => arr.reduce((s, g) => s + (g.perTheme[k] || 0), 0) / arr.length;
    for (const k of new Set(gameList.flatMap(g => Object.keys(g.perTheme)))){
      const o = rate(older, k), n = rate(recent, k);
      const pct = o > 0 ? Math.round((n - o) / o * 100) : (n > 0 ? 999 : 0);
      const dir = (o === 0 && n === 0) ? 'flat' : n < o * 0.8 ? 'down' : n > o * 1.2 ? 'up' : 'flat';
      trend[k] = {dir, pct, o, n};
    }
  }
  const lp = {}, lw = {}; let lpTotal = 0;
  for (const e of liEntries){ if (e.d < sinceMs) continue; lpTotal++;
    for (const k of liWorks(e.t)){ lp[k] = (lp[k] || 0) + 1; if (e.w) lw[k] = (lw[k] || 0) + 1; } }
  return {need, moments, occ, lp, lw, lpTotal, sinceMs, trend, nGames: gameList.length};
}

const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
function radarSVG(items){
  // Radar : polygone rouge = part des erreurs en partie, polygone bleu = part de l'entraînement (puzzles 30 j)
  const W = 560, H = 430, cx = W/2, cy = H/2 + 4, R = 118, N = items.length;
  const maxN = Math.max(...items.map(t => t.n), 0.001);
  const maxP = Math.max(...items.map(t => t.p), 1);
  const pt = (i, v) => { const a = -Math.PI/2 + i * 2*Math.PI/N; const r = 4 + v * (R - 4); return [cx + r*Math.cos(a), cy + r*Math.sin(a)]; };
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Radar de compétences" style="width:100%;height:auto;display:block">`;
  for (const f of [0.25, 0.5, 0.75, 1]){
    const pts = items.map((_, i) => pt(i, f).join(',')).join(' ');
    s += `<polygon points="${pts}" fill="none" stroke="var(--line)" stroke-width="${f === 1 ? 1.5 : 1}" opacity="${f === 1 ? 1 : 0.55}"/>`;
  }
  items.forEach((t, i) => {
    const [x, y] = pt(i, 1);
    s += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--line)" opacity="0.55"/>`;
    const a = -Math.PI/2 + i * 2*Math.PI/N;
    const lx = cx + (R + 18) * Math.cos(a), ly = cy + (R + 18) * Math.sin(a);
    const [ex, ey] = pt(i, 1.18); // bout de l'axe, au niveau du label
    const anchor = Math.cos(a) > 0.35 ? 'start' : Math.cos(a) < -0.35 ? 'end' : 'middle';
    const dy = Math.sin(a) > 0.5 ? 16 : Math.sin(a) < -0.5 ? -14 : 2;
    const on = selTheme === t.k;
    s += `<g data-theme="${esc(t.k)}" style="cursor:pointer">
      <line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" stroke="transparent" stroke-width="46"/>
      <circle cx="${x}" cy="${y}" r="9" fill="${on ? 'var(--idea)' : 'var(--line)'}"/>
      <text x="${lx}" y="${ly + dy}" text-anchor="${anchor}" fill="${on ? 'var(--idea)' : 'var(--ink)'}" font-size="13.5" font-weight="${on ? 800 : 600}" font-family="var(--body)" ${on ? 'text-decoration="underline"' : ''}>${esc(cut(workLabel(t.k), 20))}</text>
      <text x="${lx}" y="${ly + dy + 15}" text-anchor="${anchor}" fill="var(--muted)" font-size="12" font-family="var(--mono)">${t.nTxt} err · ${t.p} pz</text>
      <title>${esc(workLabel(t.k))} : ${t.nTxt} erreur(s) en partie · ${t.p} puzzle(s) sur 30 j — ${t.v[1]} — clique pour le détail</title>
    </g>`;
  });
  const poly = (vals, color) => {
    const pts = vals.map((v, i) => pt(i, v).join(',')).join(' ');
    return `<polygon points="${pts}" fill="${color}" opacity="0.16" stroke="${color}" stroke-width="2" style="pointer-events:none"/>`
      + vals.map((v, i) => { const [x, y] = pt(i, v); return `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}" style="pointer-events:none"/>`; }).join('');
  };
  s += poly(items.map(t => t.p / maxP), 'var(--time)');
  s += poly(items.map(t => t.n / maxN), 'var(--need)');
  s += '</svg>';
  return s;
}

// courbe cumulée : +1 bien joué, −1 à revoir, dans l'ordre chronologique. Monte = tu joues ce thème de mieux en mieux.
function sparkSVG(list){
  if (list.length < 2) return '<p class="muted" style="font-size:13px">Pas assez de parties pour tracer une tendance (analyses-en davantage).</p>';
  const W = 300, H = 70, pad = 8;
  let cum = 0; const pts = list.map(o => (cum += o.kind === 'good' ? 1 : -1));
  const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1;
  const x = i => pad + i * (W - 2 * pad) / (pts.length - 1);
  const y = v => H - pad - (v - lo) / span * (H - 2 * pad);
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const end = pts[pts.length - 1], col = end > 0 ? 'var(--best)' : end < 0 ? 'var(--need)' : 'var(--muted)';
  const y0 = y(0);
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:70px;display:block" role="img" aria-label="Évolution bien joué / à revoir">
    <line x1="${pad}" y1="${y0.toFixed(1)}" x2="${W - pad}" y2="${y0.toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <path d="${path}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>
    ${pts.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${list[i].kind === 'good' ? 'var(--best)' : 'var(--need)'}"/>`).join('')}
  </svg>
  <div class="tl-ax"><span>${esc(list[0].date)}</span><span>ligne qui monte = tu joues ce thème de mieux en mieux</span><span>${esc(list[list.length - 1].date)}</span></div>`;
}
function renderThemeDetail(){
  const el = $('dash-theme');
  if (!selTheme || !themeCache){ el.hidden = true; el.innerHTML = ''; return; }
  const {need, occ, lp, lw, trend} = themeCache;
  const k = selTheme, wk = WORK[k], p = lp[k] || 0;
  need[k] = need[k] || 0;
  const list = (occ[k] || []).slice().sort((a, b) => a.dk - b.dk);
  const goods = list.filter(o => o.kind === 'good'), bads = list.filter(o => o.kind === 'bad');
  const [vc, vt] = themeVerdict(need[k], p);
  const tr = trend[k];
  const trLine = tr && tr.dir !== null ? `<p style="font-size:14px;margin:0">${tr.dir === 'down' ? `<b style="color:var(--best)">▲ Tu progresses</b> : ${Math.abs(tr.pct)} % d'erreurs en moins que sur tes parties plus anciennes.` : tr.dir === 'up' ? `<b style="color:var(--need)">▼ En recul</b> : ${tr.pct} % d'erreurs en plus que sur tes parties plus anciennes.` : '<b>= Stable</b> sur ce thème.'}</p>` : '';
  const train = wk?.s ? `<a class="btn sm" style="text-decoration:none" href="https://lichess.org/training/${wk.s}" target="_blank" rel="noopener">S'entraîner ↗</a>`
    : wk?.url ? `<a class="btn sm" style="text-decoration:none" href="${esc(wk.url)}" target="_blank" rel="noopener">${wk.url.includes('chessbook') ? 'Chessbook' : 'Leçons'} ↗</a>`
    : '';
  // 2 exemples récents de chaque : représentatifs, pas la liste entière
  const recent = arr => arr.slice(-2).reverse();
  const exCard = (o, kind) => `<button type="button" class="ex ${kind}" data-open-an="${esc(o.id)}"><span class="dot ${kind}"></span><b>${esc(o.date)}</b><span>${esc(cut(o.title, 60))}</span></button>`;
  const examples = (goods.length || bads.length) ? `<div class="ex-cols">
    <div><div class="ex-h" style="color:var(--best)">Bien joué${goods.length > 2 ? ` (${goods.length}, 2 récents)` : ''}</div>${goods.length ? recent(goods).map(o => exCard(o, 'good')).join('') : '<p class="muted" style="font-size:13px">Aucun encore.</p>'}</div>
    <div><div class="ex-h" style="color:var(--need)">À revoir${bads.length > 2 ? ` (${bads.length}, 2 récents)` : ''}</div>${bads.length ? recent(bads).map(o => exCard(o, 'bad')).join('') : '<p class="muted" style="font-size:13px">Aucun encore.</p>'}</div>
  </div>` : '<p class="muted" style="font-size:13px">Pas encore d\'exemple dans tes parties analysées.</p>';
  el.hidden = false;
  el.innerHTML = `<div class="dhead"><h4 style="margin:0;font-family:var(--display);font-size:17px">${esc(workLabel(k))} <span class="pill ${vc}">${vt}</span></h4>${train}</div>
    ${sparkSVG(list)}
    ${trLine}
    ${examples}
    ${wk?.how ? `<details><summary class="muted" style="font-size:13px;cursor:pointer">Comment t'entraîner</summary><div class="howto" style="margin-top:6px"><p>${esc(wk.how)}</p></div></details>` : ''}`;
}

function renderDash(){
  themeCache = themeStats();
  const {need, lp, lw, sinceMs} = themeCache;
  const plab = period === 'all' ? 'tout' : '30 j';
  const games = ccGames || [];
  const g30 = games.filter(g => (g.endTime || 0) >= sinceMs);
  const w = g30.filter(g => g.outcome === 'victoire').length, n = g30.filter(g => g.outcome === 'nulle').length, l = g30.length - w - n;
  const p30 = liEntries.filter(e => e.d >= sinceMs); const pw = p30.filter(e => e.w).length;
  const analysedList = history.map(d => reportAcc(d.report)).filter(v => v != null);
  const avgAcc = analysedList.length ? Math.round(analysedList.reduce((a, b) => a + b, 0) / analysedList.length) : null;
  const analysed = games.filter(g => analysisFor(g.pgn)).length;
  const stat = (v, lab, sub) => `<div class="stat"><b>${esc(v)}</b><span>${esc(lab)}</span><small>${esc(sub || '')}</small></div>`;
  $('period-toggle').innerHTML = ['30j', 'all'].map(p => `<button type="button" data-period="${p}" class="${period === p ? 'on' : ''}">${p === '30j' ? '30 jours' : 'Tout'}</button>`).join('');
  $('dash-stats').innerHTML =
    stat(ccStats?.rapid ?? '…', 'elo rapide Chess.com', ccStats ? `record ${ccStats.rapidBest ?? '—'} · puzzles ${ccStats.tactics ?? '—'}` : 'chargement…') +
    stat(ccGames ? g30.length : '…', `parties (${plab})`, ccGames ? `${w} V · ${n} N · ${l} D` : 'chargement…') +
    stat(avgAcc != null ? avgAcc + '%' : '…', 'précision moyenne', `${history.length} partie${history.length > 1 ? 's' : ''} analysée${history.length > 1 ? 's' : ''}`) +
    stat(p30.length, `puzzles Lichess (${plab})`, p30.length ? `${Math.round(pw / p30.length * 100)} % réussis` : 'rien d\'importé');

  // Couverture : proposer d'analyser les parties manquantes
  const missing = games.filter(g => !analysisFor(g.pgn));
  $('dash-cov-card').hidden = !ccGames || (!missing.length && !batch);
  if (ccGames && (missing.length || batch)){
    $('dash-cov').textContent = batch
      ? 'Analyse en cours — tu peux naviguer dans l\'app, mais laisse l\'onglet ouvert.'
      : `${analysed} de tes ${games.length} parties récentes ${analysed > 1 ? 'sont analysées' : 'est analysée'} : le diagnostic ci-dessous ne voit que celles-là. Compte 1 à 2 minutes par partie (${missing.length} restante${missing.length > 1 ? 's' : ''}) ; tu peux arrêter quand tu veux.`;
    $('dash-batch').hidden = !!batch;
    $('dash-batch').textContent = `Analyser les ${missing.length} parties manquantes`;
  }

  // Radar : mêmes thèmes et même ordre que le tableau (8 premières lignes)
  const axisKeys = cmpRows.filter(r => r.k !== 'unclassified' && r.k !== 'mixed').slice(0, 8).map(r => r.k);
  if (axisKeys.length < 3){
    $('dash-star').innerHTML = `<p class="muted" style="font-size:14px">${ccGames === null ? 'Chargement…' : 'Pas encore assez de données : lance l\'analyse de tes parties récentes (bouton ci-dessus) pour construire ton radar.'}</p>`;
  } else {
    const items = axisKeys.map(k => { const nn = need[k] || 0, p = lp[k] || 0;
      return {k, n: nn, nTxt: String(+nn.toFixed(1)).replace('.', ','), p, v: themeVerdict(nn, p)}; });
    $('dash-star').innerHTML = radarSVG(items) +
      `<div class="legend" style="font-size:12px"><span>Pointe rouge sans bleu dessous = à travailler</span></div>`;
  }
  renderThemeDetail();

  if (ccGames) $('dash-games').innerHTML = games.length ? games.map((g, k) => {
    const an = analysisFor(g.pgn);
    return `<div class="grow">
      <span class="d">${esc(g.date)}</span>
      <span class="pill ${g.outcome === 'victoire' ? 'ok' : g.outcome === 'nulle' ? 'none' : 'prio'}">${esc(g.outcome)}</span>
      <span class="who"><b>vs ${esc(g.opp?.name)}</b>${g.opp?.rating ? ` (${esc(g.opp.rating)})` : ''} · ${g.me?.color === 'white' ? 'Blancs' : 'Noirs'} · ${esc(TC_FR[g.timeClass] || g.timeClass || '')}</span>
      <span class="gact">${an
        ? `<button type="button" class="btn ghost sm" data-open-an="${esc(an.id)}">Revoir l'analyse</button>`
        : `<button type="button" class="btn sm" data-analyse="${k}">Analyser</button>`}
        <a href="${esc(g.url)}" target="_blank" rel="noopener" title="Voir sur Chess.com">↗</a></span>
    </div>`;
  }).join('') : '<span class="muted" style="font-size:14px">Aucune partie trouvée ces deux derniers mois.</span>';
  $('dash-gsub').textContent = ccGames ? `— ${games.length} parties, ${analysed} analysée${analysed > 1 ? 's' : ''}` : '';

  const byDay = new Map();
  for (const e of liEntries){ if (e.d < sinceMs) continue; const day = new Date(e.d).toLocaleDateString('fr-FR'); if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(e); }
  $('dash-puzzles').innerHTML = byDay.size ? [...byDay.entries()].map(([day, es]) => {
    const ok = es.filter(e => e.w).length;
    const counts = {}; es.forEach(e => liWorks(e.t).forEach(k => counts[k] = (counts[k]||0) + 1));
    const themes = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 3).map(([k]) => workLabel(k));
    return `<div class="grow"><span class="d">${esc(day)}</span><span class="who"><b>${es.length} puzzle${es.length>1?'s':''}</b> · ${ok} réussi${ok>1?'s':''}</span><span class="themechip">${esc(themes.join(' · '))}</span></div>`;
  }).join('') : `<span class="muted" style="font-size:14px">${liToken ? 'Aucun puzzle Lichess sur les 30 derniers jours.' : 'Synchro désactivée : colle ton jeton Lichess (scope puzzle:read) dans l\'onglet Réglages.'}</span>`;
}

$('p-dash').addEventListener('click', e => {
  const t = e.target.closest('[data-theme]');
  if (t){ selTheme = selTheme === t.dataset.theme ? null : t.dataset.theme; renderDash();
    if (selTheme) $('dash-theme').scrollIntoView({behavior: 'smooth', block: 'nearest'}); return; }
  const a = e.target.closest('[data-analyse]');
  if (a){ const g = ccGames?.[+a.dataset.analyse]; if (!g || busy || batch) return;
    $('pgn').value = g.pgn; selectTab('analyses'); window.scrollTo({top: 0, behavior: 'smooth'}); analyseGame(); return; }
  const o = e.target.closest('[data-open-an]'); if (o) openAnalysis(o.dataset.openAn);
});
$('dash-refresh').addEventListener('click', () => loadCcGames(true));
$('period-toggle').addEventListener('click', e => { const b = e.target.closest('[data-period]'); if (b){ period = b.dataset.period; renderDash(); renderProgress(); } });

/* ---------- analyse par lot (parallélisée) ---------- */
let batch = null;
const POOL_SIZE = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
function renderBatchUI(){
  const st = $('batch-status');
  if (!batch){ st.hidden = true; return; }
  st.hidden = false;
  $('batch-txt').textContent = `${batch.done}/${batch.total} analysées · ${batch.running} en cours (${POOL_SIZE} en parallèle)${batch.errors ? ` · ${batch.errors} échec${batch.errors > 1 ? 's' : ''}` : ''}${batch.stopped ? ' · arrêt en cours…' : ''}`;
  $('batch-bar').style.width = Math.round(batch.done / batch.total * 100) + '%';
}
async function runBatch(){
  if (busy || batch || !ccGames) return;
  const list = ccGames.filter(g => !analysisFor(g.pgn));
  if (!list.length) return;
  const user = $('user').value.trim();
  batch = {total: list.length, done: 0, errors: 0, running: 0, stopped: false};
  busy = true; $('go').disabled = true;
  renderDash(); renderBatchUI();
  const queue = list.slice();
  const worker = async () => {
    let eng; try { eng = await makeEngine(); } catch (e) { return; } // 1 moteur dédié par voie
    while (queue.length && !batch.stopped){
      const g = queue.shift();
      batch.running++; renderBatchUI();
      try { const report = await analysePgn(g.pgn, user, () => {}, eng); await saveReport(report); }
      catch (e) { batch.errors++; console.warn('Analyse impossible :', g.label, e); }
      finally { batch.running--; batch.done++; renderBatchUI(); renderDash(); }
    }
    eng.quit();
  };
  await Promise.all(Array.from({length: POOL_SIZE}, worker));
  const {done, errors} = batch; batch = null; busy = false; $('go').disabled = false;
  renderBatchUI(); renderDash();
  $('dash-cov').textContent = `Terminé : ${done - errors} partie${done - errors > 1 ? 's' : ''} analysée${done - errors > 1 ? 's' : ''}${errors ? `, ${errors} impossible${errors > 1 ? 's' : ''} à analyser (trop courte ou PGN illisible)` : ''}.`;
  if (!$('dash-cov-card').hidden && !ccGames.filter(g => !analysisFor(g.pgn)).length) $('dash-cov-card').querySelector('h3').textContent = 'Diagnostic complet';
}
$('dash-batch').addEventListener('click', runBatch);
$('batch-stop').addEventListener('click', () => { if (batch){ batch.stopped = true; renderBatchUI(); } });

let liToken = false;
async function syncLichess(quiet){
  const b = $('dash-import'); b.disabled = true; if (!quiet) b.textContent = 'Synchronisation…';
  try {
    const cur = dbGet('puzzles_lichess');
    const since = cur?.entries?.[0]?.d ? cur.entries[0].d + 1 : undefined;
    const d = mergePuzzles(await fetchPuzzleActivity({since, max: since ? undefined : 1000}));
    liEntries = d.entries; renderProgress(); renderDash();
    if (!quiet) b.textContent = `${d.added} nouveau${d.added > 1 ? 'x' : ''} puzzle${d.added > 1 ? 's' : ''}`; }
  catch (e) { $('dash-err').hidden = false; $('dash-err').textContent = 'Synchro Lichess : ' + e.message; }
  finally { b.disabled = false; if (!quiet) setTimeout(() => { b.textContent = 'Synchroniser'; }, 2500); }
}
$('dash-import').addEventListener('click', () => {
  if (liToken) syncLichess();
  else { $('dash-err').hidden = false; $('dash-err').textContent = 'Synchro Lichess désactivée : colle ton jeton Lichess (scope puzzle:read) dans l\'onglet Réglages.'; }
});

/* ---------- réglages : UI ---------- */
function refreshIntegrations(){
  sampleFn = aiProvider() ? {json: prompt => explainAI(prompt)} : null;
  liToken = Boolean((settings.lichessToken || '').trim());
  $('dash-import').textContent = liToken ? 'Synchroniser' : 'Activer la synchro';
}
function applySettingsUI(){
  $('s-ccuser').value = settings.ccUser || ''; $('s-litoken').value = settings.lichessToken || '';
  $('s-aikey').value = settings.aiKey || ''; $('s-aimodel').value = settings.aiModel || '';
}
$('s-save').addEventListener('click', () => {
  settings = {...settings, ccUser: $('s-ccuser').value.trim(), lichessToken: $('s-litoken').value.trim(),
    aiKey: $('s-aikey').value.trim(), aiModel: $('s-aimodel').value.trim()};
  saveSettings(settings);
  $('user').value = settings.ccUser;
  ccGames = null; ccStats = null;
  refreshIntegrations();
  $('s-note').textContent = 'Enregistré ✓'; setTimeout(() => { $('s-note').textContent = ''; }, 2500);
  if ((settings.ccUser || '').trim()){ loadCcStats(); }
  if (liToken) syncLichess(true);
  renderDash();
});
$('s-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({collections: localDb.collections, docs: localDb.docs}, null, 1)], {type: 'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'chess-coach-donnees.json'; a.click(); URL.revokeObjectURL(a.href);
});
$('s-import').addEventListener('click', () => $('s-file').click());
$('s-file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d || typeof d !== 'object' || (!d.collections && !d.docs)) throw new Error('format inattendu');
    localDb = {collections: d.collections || {}, docs: d.docs || {}};
    if (!persistDb()) throw new Error('fichier trop gros pour le stockage du navigateur');
    loadAnalyses(); loadSessions(); loadPuzzles();
    $('s-note').textContent = 'Données importées ✓'; setTimeout(() => { $('s-note').textContent = ''; }, 2500);
  } catch (err) { $('s-note').textContent = 'Import impossible : ' + (err.message || 'fichier illisible'); }
});
$('s-reset').addEventListener('click', () => {
  if (!confirm('Effacer toutes les analyses, puzzles et réglages stockés dans ce navigateur ?')) return;
  localStorage.removeItem(DBKEY); localStorage.removeItem(SKEY);
  location.reload();
});

/* ---------- boot ---------- */
try { if (settings.ccUser) $('user').value = settings.ccUser; } catch {}
$('go').addEventListener('click', analyseGame);
if (typeof Chess === 'undefined') { $('go').disabled = true; fail('La bibliothèque d\'échecs n\'a pas chargé. Recharge la page ; en local, sers le dossier avec un petit serveur (ex. « npx serve . » ou « python3 -m http.server »).'); }
(async () => {
  try { EXAMPLE = await (await fetch('data/example.json')).json(); } catch {}
  if (EXAMPLE) renderReport(EXAMPLE);
  db = true;
  applySettingsUI();
  refreshIntegrations();
  loadAnalyses(); loadSessions(); loadPuzzles();
  if (!$('p-dash').hidden && ($('user').value || '').trim()) loadCcGames();
  if (($('user').value || '').trim()) loadCcStats();
  if (liToken) syncLichess(true); // synchro auto des puzzles au chargement
})();
