'use strict';
require('dotenv').config();
const express   = require('express');
const cron      = require('node-cron');
const path      = require('path');
const crypto    = require('crypto');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const { db, q, getSetting, setSetting } = require('./lib/db');
const { TZ, todayStr, monthStart, addDays } = require('./lib/dates');
const { computeState, publicState } = require('./lib/engine');
const { latestInsights } = require('./lib/forecast');
const { syncAccount } = require('./lib/sync');
const { testChannel, getChannels } = require('./lib/notify');
const jobs = require('./lib/jobs');
const meta = require('./lib/meta');
const google = require('./lib/google');

// ── Configuración obligatoria (sin valores por defecto inseguros) ─────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET     = process.env.JWT_SECRET;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 10 || !JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[config] Faltan ADMIN_PASSWORD (mín. 10 caracteres) y/o JWT_SECRET (mín. 32 caracteres). No se inicia el servidor.');
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3002;
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') return res.redirect(301, 'https://' + req.headers.host + req.url);
  next();
});
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' }) });
app.use('/api/', rateLimit({ windowMs: 10 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Sesión (JWT HS256 liviano) ────────────────────────────────────────
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function signToken(payload) {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ ...payload, iat: Date.now() });
  return `${h}.${b}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
function verifyToken(t) {
  try {
    const [h, b, s] = t.split('.');
    const exp = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
    if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return Date.now() - p.iat > 12 * 3600 * 1000 ? null : p;
  } catch { return null; }
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ') && verifyToken(h.slice(7))) return next();
  res.status(401).json({ error: 'Sesión vencida. Volvé a ingresar.' });
}
const badRequest = msg => Object.assign(new Error(msg), { status: 400 });
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  if (!e.status) console.error('[api]', req.path, e.message);
  res.status(e.status || 500).json({ error: e.message });
});

app.post('/api/login', loginLimiter, (req, res) => {
  const pwd = Buffer.from(String(req.body?.password || ''));
  const adm = Buffer.from(ADMIN_PASSWORD);
  if (pwd.length === adm.length && crypto.timingSafeEqual(pwd, adm)) return res.json({ ok: true, token: signToken({ role: 'admin' }) });
  console.warn(`[security] Login fallido desde ${req.ip}`);
  res.status(401).json({ error: 'Contraseña incorrecta' });
});

// ── Dashboard ─────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const state = await computeState();
  const pub = publicState(state);
  const insights = await latestInsights(pub.clients.map(c => c.id));
  const alerts = await q(db().from('alerts').select('id,client_id,account_id,severity,rule_key,message,first_seen_at').eq('status', 'open'));
  const unassigned = await q(db().from('ad_accounts').select('id', { count: 'exact', head: false }).is('client_id', null));
  const lastRun = await q(db().from('sync_runs').select('job,status,started_at,finished_at').order('started_at', { ascending: false }).limit(1));
  res.json({ ...pub, insights, alerts, unassigned_accounts: unassigned.length, last_run: lastRun[0] || null, running: jobs.isRunning(),
    connectors: { meta: meta.isConfigured(), google_ads: google.isConfigured() } });
}));

// ── Cuentas publicitarias ─────────────────────────────────────────────
app.get('/api/accounts', auth, wrap(async (req, res) => {
  res.json(await q(db().from('ad_accounts').select('id,client_id,platform,external_id,name,currency,status,status_detail,monitored,last_synced_at,last_error').order('platform').order('name')));
}));
// Alta manual: plataforma + ID. Se consulta la API para traer nombre y
// estado; si no hay acceso todavía, la cuenta se guarda igual con el error
// visible (se reintenta en cada sincronización).
app.post('/api/accounts', auth, wrap(async (req, res) => {
  const { platform, external_id, client_id, name } = req.body;
  const conn = { meta, google_ads: google }[platform];
  if (!conn) throw badRequest('Elegí la plataforma');
  const id = conn.normalizeId(external_id);
  if (!id) throw badRequest(platform === 'meta' ? 'ID de cuenta de Meta inválido (ej: act_123456789 o 123456789)' : 'ID de Google Ads inválido (10 dígitos, ej: 123-456-7890)');
  const dup = await q(db().from('ad_accounts').select('id').eq('platform', platform).eq('external_id', id));
  if (dup.length) throw badRequest('Esa cuenta ya está cargada');

  let info = {}, warning = null;
  if (!conn.isConfigured()) warning = `${platform === 'meta' ? 'Meta' : 'Google Ads'} todavía no tiene credenciales cargadas en Render. La cuenta queda guardada y se va a leer cuando estén.`;
  else {
    try { info = await conn.fetchAccountInfo(id); }
    catch (e) { warning = `No se pudo leer la cuenta: ${e.message}. Queda guardada; revisá que el usuario tenga acceso.`; }
  }
  const row = {
    platform, external_id: id, client_id: client_id || null, monitored: true,
    name: (name && String(name).trim()) || info.name || id,
    currency: info.currency || null, timezone: info.timezone || null,
    status: info.status || null, status_detail: info.status_detail || {},
    last_error: warning && conn.isConfigured() ? warning.slice(0, 500) : null,
  };
  const acc = (await q(db().from('ad_accounts').insert(row).select()))[0];
  if (!warning) syncAccount(acc).catch(e => console.error('[first sync]', e.message)); // primera carga en segundo plano
  res.json({ account: acc, warning });
}));
app.delete('/api/accounts/:id', auth, wrap(async (req, res) => {
  await q(db().from('ad_accounts').delete().eq('id', req.params.id)); // borra también sus métricas y campañas
  res.json({ ok: true });
}));
app.put('/api/accounts/:id', auth, wrap(async (req, res) => {
  const patch = {};
  if ('client_id' in req.body) patch.client_id = req.body.client_id || null;
  if ('monitored' in req.body) patch.monitored = !!req.body.monitored;
  else if (patch.client_id) patch.monitored = true; // asignar a un cliente = empezar a monitorear
  const rows = await q(db().from('ad_accounts').update(patch).eq('id', req.params.id).select());
  const acc = rows[0];
  if (!acc) return res.status(404).json({ error: 'Cuenta no encontrada' });
  // Primera carga de datos en segundo plano, para no esperar al sync de mañana
  if (acc.monitored && !acc.last_synced_at) syncAccount(acc).catch(e => console.error('[first sync]', e.message));
  res.json(acc);
}));

// ── Clientes ──────────────────────────────────────────────────────────
const slugify = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = v => (v === '' || v == null || isNaN(parseFloat(v)) ? null : parseFloat(v));
function clientFields(b) {
  const f = {};
  if (b.name != null) f.name = String(b.name).trim();
  if (b.client_type) f.client_type = b.client_type;
  if (b.currency) f.currency = String(b.currency).toUpperCase();
  if ('active' in b) f.active = !!b.active;
  if ('notes' in b) f.notes = b.notes || '';
  for (const k of ['target_cpa', 'target_cpl', 'target_roas', 'target_revenue']) if (k in b) f[k] = num(b[k]);
  if ('target_leads' in b) f.target_leads = num(b.target_leads) == null ? null : Math.round(num(b.target_leads));
  return f;
}
app.get('/api/clients', auth, wrap(async (req, res) => {
  res.json(await q(db().from('clients').select('*').order('name')));
}));
app.post('/api/clients', auth, wrap(async (req, res) => {
  const f = clientFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Falta el nombre' });
  let slug = slugify(f.name) || 'cliente';
  const exists = await q(db().from('clients').select('slug').like('slug', slug + '%'));
  if (exists.some(e => e.slug === slug)) slug += '-' + (exists.length + 1);
  res.json((await q(db().from('clients').insert({ ...f, slug }).select()))[0]);
}));
app.put('/api/clients/:id', auth, wrap(async (req, res) => {
  res.json((await q(db().from('clients').update(clientFields(req.body)).eq('id', req.params.id).select()))[0]);
}));
app.delete('/api/clients/:id', auth, wrap(async (req, res) => {
  await q(db().from('ad_accounts').update({ client_id: null, monitored: false }).eq('client_id', req.params.id));
  await q(db().from('clients').delete().eq('id', req.params.id));
  res.json({ ok: true });
}));

// ── Presupuestos ──────────────────────────────────────────────────────
app.get('/api/budgets', auth, wrap(async (req, res) => {
  const month = req.query.month || monthStart(addDays(todayStr(), -1));
  res.json({ month, budgets: await q(db().from('budgets').select('*').eq('month', month)) });
}));
// platform: 'meta' | 'google_ads' | null (total). amount vacío = borrar.
app.put('/api/budgets', auth, wrap(async (req, res) => {
  const { client_id, platform = null, month, amount } = req.body;
  if (!client_id || !/^\d{4}-\d{2}-01$/.test(month || '')) return res.status(400).json({ error: 'Faltan client_id o month (YYYY-MM-01)' });
  let sel = db().from('budgets').select('id').eq('client_id', client_id).eq('month', month);
  sel = platform ? sel.eq('platform', platform) : sel.is('platform', null);
  const ex = (await q(sel))[0];
  const val = num(amount);
  if (val == null) { if (ex) await q(db().from('budgets').delete().eq('id', ex.id)); return res.json({ ok: true, deleted: true }); }
  if (ex) await q(db().from('budgets').update({ amount: val }).eq('id', ex.id));
  else await q(db().from('budgets').insert({ client_id, platform: platform || null, month, amount: val }));
  res.json({ ok: true });
}));

// ── Alertas ───────────────────────────────────────────────────────────
app.get('/api/alerts', auth, wrap(async (req, res) => {
  const status = req.query.status || 'open';
  let sel = db().from('alerts').select('*').order('last_seen_at', { ascending: false }).limit(300);
  sel = status === 'all' ? sel : sel.eq('status', status);
  res.json(await q(sel));
}));
app.post('/api/alerts/:id/snooze', auth, wrap(async (req, res) => {
  const hours = Math.min(24 * 30, Math.max(1, parseInt(req.body.hours || 24, 10)));
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await q(db().from('alerts').update({ status: 'snoozed', snoozed_until: until }).eq('id', req.params.id));
  res.json({ ok: true, snoozed_until: until });
}));
app.post('/api/alerts/:id/reopen', auth, wrap(async (req, res) => {
  await q(db().from('alerts').update({ status: 'open', snoozed_until: null }).eq('id', req.params.id));
  res.json({ ok: true });
}));

// ── Canales de aviso ──────────────────────────────────────────────────
const CH_TYPES = ['email', 'slack'];
function channelFields(b) {
  const f = {};
  if (b.type) { if (!CH_TYPES.includes(b.type)) throw badRequest('Tipo de canal inválido'); f.type = b.type; }
  for (const k of ['label', 'target', 'min_severity', 'mode']) if (b[k] != null) f[k] = String(b[k]).trim();
  if ('client_id' in b) f.client_id = b.client_id || null;
  if ('quiet_hours' in b) f.quiet_hours = !!b.quiet_hours;
  if ('active' in b) f.active = !!b.active;
  if (f.type === 'slack' && f.target && !/^https:\/\/hooks\.slack\.com\//.test(f.target)) throw badRequest('El webhook de Slack tiene que empezar con https://hooks.slack.com/');
  if (f.type === 'email' && f.target && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.target)) throw badRequest('Mail inválido');
  return f;
}
app.get('/api/channels', auth, wrap(async (req, res) => {
  const all = await getChannels();
  const rows = await q(db().from('notification_channels').select('*').order('created_at'));
  res.json({ channels: rows, from_env: all.filter(c => !c.id).map(c => ({ ...c, target: c.type === 'slack' ? 'hooks.slack.com/…' : c.target })) });
}));
app.post('/api/channels', auth, wrap(async (req, res) => {
  const f = channelFields(req.body);
  if (!f.type || !f.target) return res.status(400).json({ error: 'Faltan tipo y destino' });
  res.json((await q(db().from('notification_channels').insert(f).select()))[0]);
}));
app.put('/api/channels/:id', auth, wrap(async (req, res) => {
  res.json((await q(db().from('notification_channels').update(channelFields(req.body)).eq('id', req.params.id).select()))[0]);
}));
app.delete('/api/channels/:id', auth, wrap(async (req, res) => {
  await q(db().from('notification_channels').delete().eq('id', req.params.id));
  res.json({ ok: true });
}));
app.post('/api/channels/:id/test', auth, wrap(async (req, res) => {
  const ch = (await q(db().from('notification_channels').select('*').eq('id', req.params.id)))[0];
  if (!ch) return res.status(404).json({ error: 'Canal no encontrado' });
  await testChannel(ch);
  res.json({ ok: true });
}));

// ── Configuración y corridas ──────────────────────────────────────────
app.get('/api/settings', auth, wrap(async (req, res) => {
  res.json({ alerts: await getSetting('alerts', {}), schedule: await jobs.scheduleConfig() });
}));
app.put('/api/settings', auth, wrap(async (req, res) => {
  const { alerts, schedule } = req.body;
  if (alerts) {
    const a = {};
    for (const k of ['pacing_warning_pp', 'pacing_critical_pp', 'quiet_start', 'quiet_end']) if (alerts[k] != null) a[k] = Number(alerts[k]);
    await setSetting('alerts', { ...(await getSetting('alerts', {})), ...a });
  }
  if (schedule) {
    const cur = await getSetting('schedule', {});
    const next = { ...cur };
    if (schedule.digest) next.daily = { enabled: !!schedule.digest.enabled, hour: +schedule.digest.hour, minute: +schedule.digest.minute || 0 };
    if (schedule.checks) next.checks = { enabled: !!schedule.checks.enabled, hours: (schedule.checks.hours || []).map(Number).filter(h => h >= 0 && h < 24) };
    await setSetting('schedule', next);
    await initCron();
  }
  res.json({ ok: true });
}));
app.get('/api/runs', auth, wrap(async (req, res) => {
  res.json(await q(db().from('sync_runs').select('*').order('started_at', { ascending: false }).limit(40)));
}));
// Ejecutar a mano: sync | check | digest (responde enseguida, corre en segundo plano)
app.post('/api/run/:job', auth, wrap(async (req, res) => {
  const fn = { sync: jobs.dailyJob, check: jobs.criticalJob, digest: () => jobs.digestJob({ force: true }) }[req.params.job];
  if (!fn) return res.status(400).json({ error: 'Tarea desconocida' });
  if (jobs.isRunning()) return res.status(409).json({ error: `Ya hay una tarea corriendo (${jobs.isRunning()})` });
  fn();
  res.json({ ok: true, started: req.params.job });
}));

app.get('/health', (_, res) => res.json({ ok: true, app: 'paid-media-ads-monitor', version: '3.0.0' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Tareas programadas (hora argentina) ───────────────────────────────
const tasks = [];
async function initCron() {
  tasks.splice(0).forEach(t => t.stop());
  const cfg = await jobs.scheduleConfig().catch(() => null);
  if (!cfg) return;
  tasks.push(cron.schedule(`${cfg.sync.minute} ${cfg.sync.hour} * * *`, () => jobs.dailyJob(), { timezone: TZ }));
  if (cfg.digest.enabled) tasks.push(cron.schedule(`${cfg.digest.minute || 0} ${cfg.digest.hour} * * *`, () => jobs.digestJob(), { timezone: TZ }));
  if (cfg.checks.enabled && cfg.checks.hours?.length) {
    tasks.push(cron.schedule(`30 ${cfg.checks.hours.join(',')} * * *`, () => jobs.criticalJob(), { timezone: TZ }));
  }
  console.log(`[cron] sync ${cfg.sync.hour}:${String(cfg.sync.minute).padStart(2, '0')} · resumen ${cfg.digest.enabled ? cfg.digest.hour + ':' + String(cfg.digest.minute || 0).padStart(2, '0') : 'off'} · chequeos ${cfg.checks.enabled ? cfg.checks.hours.map(h => h + ':30').join(', ') : 'off'}`);
}

if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`[server] Paid Media Ads Monitor · puerto ${PORT} · Meta ${meta.isConfigured() ? 'OK' : 'sin configurar'} · Google Ads ${google.isConfigured() ? 'OK' : 'sin configurar'}`);
    await initCron();
  });
}

module.exports = { app };
