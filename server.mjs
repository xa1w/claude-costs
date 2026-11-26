// Claude Code cost tracker: reads ~/.claude/projects/**/*.jsonl, prices usage at API rates, serves a dashboard.
// Run: node server.mjs  → http://localhost:3240
import { createServer } from 'node:http';
import { createReadStream, readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(homedir(), '.claude', 'projects');
const HERE = dirname(new URL(import.meta.url).pathname);
const CACHE = join(HERE, '.cache.json');
const PORT = +process.env.PORT || 3240;

// $ per million tokens: [input, output, cacheRead]. Cache writes: 1.25x input (5m), 2x input (1h).
// ponytail: hand-kept table, update when prices change. Haiku 5.5's >100K-prompt tier is ignored.
const PRICES = {
  'claude-fable-5-2': [8, 40, 0.2], 'claude-mythos-5-2': [8, 40, 0.2],
  'claude-fable-5-1': [10, 50, 1], 'claude-mythos-5-1': [10, 50, 1], 'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2], 'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5], 'claude-opus-4-7': [5, 25, 0.5], 'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.1], 'claude-sonnet-5': [2, 10, 0.2], 'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01], 'claude-haiku-4-5': [1, 5, 0.1],
};
const priceFor = m => PRICES[m] || PRICES[m?.replace(/-\d{8}$/, '')];

export function cost(model, u) {
  const p = priceFor(model);
  if (!p) return 0;
  const [inp, out, read] = p;
  const c = u.cache_creation || {};
  const w1h = c.ephemeral_1h_input_tokens ?? 0;
  const w5m = c.ephemeral_5m_input_tokens ?? ((u.cache_creation_input_tokens || 0) - w1h);
  return ((u.input_tokens || 0) * inp + (u.output_tokens || 0) * out + (u.cache_read_input_tokens || 0) * read
    + w5m * inp * 1.25 + w1h * inp * 2) / 1e6;
}

// file → { key: "mtime:size", title, msgs: [[id, ts, model, cost, tokensIn, tokensOut]] }
let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch {}

function listFiles() {
  const out = [];
  for (const proj of readdirSync(ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pdir = join(ROOT, proj.name);
    for (const e of readdirSync(pdir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: join(pdir, e.name), project: proj.name, session: e.name.slice(0, -6) });
      else if (e.isDirectory()) {
        const sub = join(pdir, e.name, 'subagents');
        if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith('.jsonl'))
          out.push({ file: join(sub, s), project: proj.name, session: e.name });
      }
    }
  }
  return out;
}

async function parse(file) {
  const seen = new Set(), msgs = [];
  let custom = null, ai = null, prompt = null;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.includes('"custom-title"')) { try { custom = JSON.parse(line).customTitle || custom; } catch {} continue; }
    if (line.includes('"ai-title"')) { try { ai = JSON.parse(line).aiTitle || ai; } catch {} continue; }
    if (!prompt && line.startsWith('{') && line.includes('"type":"user"')) {
      try { const c = JSON.parse(line).message?.content; if (typeof c === 'string' && !c.startsWith('<')) prompt = c.slice(0, 120); } catch {}
      continue;
    }
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type !== 'assistant' || !m?.usage || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const u = m.usage;
    msgs.push([m.id, Date.parse(e.timestamp) || 0, m.model, cost(m.model, u),
      (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), u.output_tokens || 0]);
  }
  return { title: custom || ai || prompt, msgs };
}

let scanning = null;
async function scan() {
  const files = listFiles(), live = new Set();
  for (const f of files) {
    live.add(f.file);
    let st; try { st = statSync(f.file); } catch { continue; }
    const key = `v2:${st.mtimeMs}:${st.size}`; // bump v when parse() changes
    if (cache[f.file]?.key === key) continue;
    cache[f.file] = { key, project: f.project, session: f.session, sub: f.file.includes('/subagents/'), ...(await parse(f.file)) };
  }
  for (const k of Object.keys(cache)) if (!live.has(k)) delete cache[k];
  writeFileSync(CACHE, JSON.stringify(cache));
}

function prettyProject(p) {
  return p.replace(/^-Users-[^-]+-?/, '').replace(/^Desktop-claude-?/, 'claude ').replace(/^Projects-/, '').replace(/^-?Volumes-ClaudeDev-/, '').replace(/^-+claude-mem-observer-sessions$/, 'claude-mem').trim() || '~';
}

function aggregate() {
  const seen = new Set(), sessions = {}, days = {}, models = {};
  // Main files first so resumed/forked copies of a message count once, under the earliest session.
  const entries = Object.values(cache).sort((a, b) => (a.msgs[0]?.[1] || 0) - (b.msgs[0]?.[1] || 0));
  for (const f of entries) {
    const s = sessions[f.session] ??= { id: f.session, project: prettyProject(f.project), title: null, cost: 0, tin: 0, tout: 0, msgs: 0, start: Infinity, end: 0, models: {} };
    if (!f.sub && f.title) s.title = f.title;
    for (const [id, ts, model, c, tin, tout] of f.msgs) {
      if (seen.has(id)) continue;
      seen.add(id);
      s.cost += c; s.tin += tin; s.tout += tout; s.msgs++;
      s.start = Math.min(s.start, ts); s.end = Math.max(s.end, ts);
      s.models[model] = (s.models[model] || 0) + c;
      const d = new Date(ts); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days[day] = (days[day] || 0) + c;
      const mm = models[model] ??= { cost: 0, msgs: 0, priced: !!priceFor(model) };
      mm.cost += c; mm.msgs++;
    }
  }
  const list = Object.values(sessions).filter(s => s.msgs).map(s => ({
    ...s, model: Object.entries(s.models).sort((a, b) => b[1] - a[1])[0]?.[0], models: undefined,
  })).sort((a, b) => b.end - a.end);
  return { sessions: list, days, models, generated: Date.now() };
}

/* ---------- Codex + Antigravity ---------- */
const dayOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const openDb = f => { try { return new DatabaseSync(f, { readOnly: true }); } catch { return null; } };
const prefixPrice = (table, m) => table[Object.keys(table).filter(k => m?.startsWith(k)).sort((a, b) => b.length - a.length)[0]];

// Third-party-listed rates, Nov 2026: [input, cachedInput, output] $/M.
const OPENAI = { 'gpt-6.1-sol': [2, 0.1, 10], 'gpt-6-astra': [10, 1, 50], 'gpt-6-luna': [0.1, 0.01, 0.5] };
// ponytail: Codex only stores one total per thread, so price it with an assumed agentic mix
// (90% cached input, 8% fresh input, 2% output). Rough; per-turn rollout token events are all zero here.
const MIX = [0.08, 0.9, 0.02];
const codexRate = m => { const p = OPENAI[m] || OPENAI['gpt-6.1-sol']; return (MIX[0] * p[0] + MIX[1] * p[1] + MIX[2] * p[2]) / 1e6; };

// Codex falls back to the raw first prompt as a title: drop markdown markers and HTML entities.
const cleanTitle = s => s && s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&').replace(/\\(.)/g, '$1')
  .replace(/^[#>*\s-]+/, '').replace(/\s+/g, ' ').trim().slice(0, 140);

function codex() {
  const db = openDb(join(homedir(), '.codex', 'state_5.sqlite'));
  const out = { sessions: [], days: {}, models: {} };
  if (!db) return out;
  for (const t of db.prepare('select id, title, cwd, model, tokens_used, created_at, updated_at from threads where tokens_used > 0').all()) {
    const model = t.model || 'codex', cost = t.tokens_used * codexRate(t.model);
    const end = t.updated_at * 1000;
    out.sessions.push({ id: t.id, tool: 'codex', title: cleanTitle(t.title), project: basename(t.cwd || '') || '~', cost, tin: t.tokens_used, tout: 0, msgs: 1, start: t.created_at * 1000, end, model, estimate: true });
    out.days[dayOf(end)] = (out.days[dayOf(end)] || 0) + cost; // ponytail: whole thread lands on its last day
    const mm = out.models[model] ??= { cost: 0, msgs: 0, priced: true }; mm.cost += cost; mm.msgs++;
  }
  db.close();
  return out;
}

// Minimal protobuf reader: field number → list of varints / byte slices.
function pb(buf) {
  const f = {}; let i = 0;
  const varint = () => { let r = 0, s = 0, c; do { c = buf[i++]; r += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80 && i < buf.length); return r; };
  try {
    while (i < buf.length) {
      const k = varint(), n = Math.floor(k / 8), t = k & 7;
      if (t > 5) break;
      let v = null;
      if (t === 0) v = varint();
      else if (t === 2) { const len = varint(); v = buf.subarray(i, i += len); }
      else i += t === 1 ? 8 : 4;
      (f[n] ??= []).push(v);
    }
  } catch {}
  return f;
}
// Gemini 3.8 Flash intro rate (doubles Jan 1, 2027): [input, output] $/M. Claude models fall back to PRICES.
const GOOGLE = { 'gemini-3.8-flash': [0.75, 3.75] };

function antigravity() {
  const out = { sessions: [], days: {}, models: {} }, seen = new Set();
  for (const dir of readdirSync(join(homedir(), '.gemini')).filter(d => d.startsWith('antigravity'))) {
    const base = join(homedir(), '.gemini', dir), convDir = join(base, 'conversations');
    if (!existsSync(convDir)) continue;
    const titles = {}, sdb = openDb(join(base, 'conversation_summaries.db'));
    if (sdb) { for (const r of sdb.prepare('select conversation_id, title, workspace_uris from conversation_summaries').all()) titles[r.conversation_id] = r; sdb.close(); }
    // ponytail: older .pb-only conversations carry no readable usage, so only .db conversations count.
    for (const file of readdirSync(convDir).filter(f => f.endsWith('.db'))) {
      const id = file.slice(0, -3);
      if (seen.has(id)) continue; seen.add(id);
      const db = openDb(join(convDir, file)); if (!db) continue;
      const end = statSync(join(convDir, file)).mtimeMs; // ponytail: no per-generation timestamp found; uses file mtime
      const s = { id, tool: 'antigravity', title: titles[id]?.title || null, project: basename(decodeURIComponent((titles[id]?.workspace_uris || '').match(/file:\/\/([^"',\]]+)/)?.[1] || '')) || '~', cost: 0, tin: 0, tout: 0, msgs: 0, start: end, end, models: {} };
      for (const { data } of db.prepare('select data from gen_metadata').all()) {
        const inner = pb(pb(data)[1]?.[0] || new Uint8Array())
        const usage = pb(inner[4]?.[0] || new Uint8Array());
        const model = inner[19]?.[0] ? Buffer.from(inner[19][0]).toString() : 'unknown';
        const tin = usage[2]?.[0] || 0, tout = usage[3]?.[0] || 0;
        const g = prefixPrice(GOOGLE, model), c = priceFor(model.replace(/-n$/, ''));
        const cost = g ? (tin * g[0] + tout * g[1]) / 1e6 : c ? (tin * c[0] + tout * c[1]) / 1e6 : 0;
        s.cost += cost; s.tin += tin; s.tout += tout; s.msgs++;
        s.models[model] = (s.models[model] || 0) + cost;
        const mm = out.models[model] ??= { cost: 0, msgs: 0, priced: !!(g || c) }; mm.cost += cost; mm.msgs++;
      }
      db.close();
      if (!s.msgs) continue;
      out.days[dayOf(end)] = (out.days[dayOf(end)] || 0) + s.cost;
      out.sessions.push({ ...s, model: Object.entries(s.models).sort((a, b) => b[1] - a[1])[0]?.[0], models: undefined });
    }
  }
  return out;
}

// DEMO=1 serves seeded fake sessions (used for the README screenshots).
function demo() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const T = ['Fix flaky auth tests', 'Landing page hero redesign', 'Migrate to Postgres 18', 'Add dark mode', 'Refactor billing webhooks',
    'Write onboarding docs', 'Speed up image pipeline', 'Debug memory leak in worker', 'Ship pricing page', 'CLI for release notes',
    'Port charts to SVG', 'Set up CI cache', 'Accessibility pass on forms', 'Rate limiter for API', 'Search with trigram index'];
  const P = ['web-app', 'api', 'docs', 'cli', 'design-system', 'infra'];
  const tools = { claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5'], codex: ['gpt-6.1-sol', 'gpt-6-astra'], antigravity: ['gemini-3.8-flash', 'gemini-3.8-pro'] };
  const out = {}, now = Date.now();
  for (const [tool, ms] of Object.entries(tools)) {
    const o = out[tool] = { sessions: [], days: {}, models: {} };
    const n = tool === 'claude' ? 260 : 60;
    for (let i = 0; i < n; i++) {
      const end = i === 0 && tool === 'claude' ? now - 60e3 : now - Math.pow(rnd(), 1.6) * 175 * 864e5;
      const model = pick(ms), cost = Math.pow(rnd(), 2.2) * (tool === 'claude' ? 60 : 12) + 0.05;
      const s = { id: `${tool}-${i}`, tool, project: pick(P), title: pick(T), cost, tin: Math.round(cost * 2e5), tout: Math.round(cost * 9e3),
        msgs: Math.round(cost * 8) + 3, start: end - rnd() * 3 * 36e5, end, model, estimate: tool === 'codex' };
      o.sessions.push(s);
      o.days[dayOf(end)] = (o.days[dayOf(end)] || 0) + cost;
      const mm = o.models[model] ??= { cost: 0, msgs: 0, priced: true }; mm.cost += cost; mm.msgs += s.msgs;
    }
    o.sessions.sort((a, b) => b.end - a.end);
  }
  return out;
}

// Images in this folder or clawd/; the pattern rules out any path traversal.
const IMG = /^\/((?:clawd\/)?[\w-]+\.(png|gif|svg))$/;
const MIME = { png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml' };

createServer(async (req, res) => {
  if (req.url.startsWith('/api/data') && process.env.DEMO) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ tools: demo(), generated: Date.now() }));
  }
  if (req.url.startsWith('/api/data')) {
    scanning ??= scan().finally(() => { scanning = null; });
    try {
      await scanning;
      const claude = aggregate();
      claude.sessions.forEach(s => s.tool = 'claude');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ tools: { claude, codex: codex(), antigravity: antigravity() }, generated: Date.now() }));
    } catch (e) { res.writeHead(500); return res.end(String(e)); }
  }
  const img = req.url.match(IMG);
  if (img && existsSync(join(HERE, img[1]))) { res.writeHead(200, { 'content-type': MIME[img[2]], 'cache-control': 'max-age=3600' }); return res.end(readFileSync(join(HERE, img[1]))); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(join(HERE, 'index.html')));
}).listen(PORT, '127.0.0.1', () => console.log(`claude costs → http://localhost:${PORT}`));
