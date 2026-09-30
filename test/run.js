'use strict';
// Prueba de punta a punta con APIs de Meta / Google / Anthropic / Resend /
// Slack simuladas y una base PostgREST local (misma API que Supabase).
// Uso: SUPABASE_URL=http://localhost:3010 SUPABASE_SERVICE_KEY=x node test/run.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

Object.assign(process.env, {
  META_SYSTEM_USER_TOKEN: 'tok', ADMIN_PASSWORD: 'prueba-segura-123', JWT_SECRET: 'x'.repeat(40),
  GOOGLE_ADS_MCC_ID: '123-456-7890', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev', GOOGLE_ADS_CLIENT_ID: 'cid',
  GOOGLE_ADS_CLIENT_SECRET: 'sec', GOOGLE_ADS_REFRESH_TOKEN: 'ref',
  ANTHROPIC_API_KEY: 'ak', RESEND_API_KEY: 'rk', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
  ALERT_EMAILS: 'juan@doctanexus.com',
});

const { todayStr, addDays } = require('../lib/dates');
const TODAY = todayStr();
const Y = addDays(TODAY, -1);

// ── Escenario simulado ─────────────────────────────────────────────
const SC = {
  meta: {
    act_1: { name: 'Cliente A — Meta', status: 1, spend: d => 1000, purch: 3, active: true },
    act_2: { name: 'Cuenta caída', status: 2, reason: 3, spend: d => 0, active: true },
    act_3: { name: 'Cliente B — Meta', status: 1, spend: d => (d === Y ? 0 : 400), purch: 0, active: true },
  },
  google: {
    '1111111111': { name: 'Cliente A — Google', status: 'ENABLED', spend: d => 500, conv: 2, lostIS: 0.35 },
    '2222222222': { name: 'Cliente B — Google', status: 'ENABLED', spend: d => 300, conv: 0 },
  },
};
const sent = { slack: [], email: [], anthropic: 0 };

const realFetch = global.fetch;
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => JSON.stringify(o) });
function daysBetween(s, u) { const out = []; for (let d = s; d <= u; d = addDays(d, 1)) out.push(d); return out; }

global.fetch = async (input, opts = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'localhost') return realFetch(input, opts);
  if (url.hostname === 'graph.facebook.com') {
    const p = url.pathname.replace(/^\/v[\d.]+/, '');
    const qp = k => url.searchParams.get(k);
    if (p === '/999/owned_ad_accounts') return json({ data: Object.entries(SC.meta).map(([id, a]) => ({ id, name: a.name, account_status: a.status, disable_reason: a.reason || 0, currency: 'ARS', timezone_name: 'America/Argentina/Buenos_Aires' })) });
    if (p === '/999/client_ad_accounts') return json({ data: [] });
    const m = p.match(/^\/(act_\d+)(\/\w+)?$/);
    if (!m) return json({ error: { message: 'mock: ruta desconocida ' + p } }, 400);
    const a = SC.meta[m[1]];
    if (!a) return json({ error: { message: 'Unsupported get request. Object does not exist or no permissions' } }, 400);
    if (!m[2]) return json({ account_status: a.status, disable_reason: a.reason || 0, name: a.name, currency: 'ARS', timezone_name: 'America/Argentina/Buenos_Aires' });
    if (m[2] === '/campaigns') return json({ data: [{ id: m[1] + '_c1', name: 'Campaña 1', effective_status: a.active ? 'ACTIVE' : 'PAUSED', objective: 'OUTCOME_SALES', daily_budget: '100000' }] });
    if (m[2] === '/ads') return json({ data: [], summary: { total_count: m[1] === 'act_1' ? 2 : 0 } });
    if (m[2] === '/insights') {
      const tr = JSON.parse(qp('time_range'));
      if (!qp('time_increment')) return json({ data: [{ frequency: m[1] === 'act_1' ? '4.6' : '1.8', cpm: '1000', ctr: '1.2' }] });
      const rows = daysBetween(tr.since, tr.until).map(d => {
        const s = a.spend(d);
        return { date_start: d, spend: String(s), impressions: String(s * 10), clicks: String(s / 10), reach: String(s * 5), frequency: '2',
          actions: s ? [{ action_type: 'omni_purchase', value: String(a.purch || 0) }] : [], action_values: s ? [{ action_type: 'omni_purchase', value: String((a.purch || 0) * 5000) }] : [],
          campaign_id: m[1] + '_c1', campaign_name: 'Campaña 1' };
      }).filter(r => r.spend !== '0' || qp('level') === 'account');
      return json({ data: rows });
    }
  }
  if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'gtok', expires_in: 3600 });
  if (url.hostname === 'googleads.googleapis.com') {
    const cid = url.pathname.match(/customers\/(\d+)/)[1];
    const query = JSON.parse(opts.body).query;
    assert.strictEqual(opts.headers['login-customer-id'], '1234567890', 'login-customer-id debe ser el MCC sin guiones');
    if (query.includes('FROM customer_client')) return json({ results: Object.entries(SC.google).map(([id, g]) => ({ customerClient: { id, descriptiveName: g.name, currencyCode: 'ARS', timeZone: 'America/Argentina/Buenos_Aires', status: g.status, manager: false, level: 1 } })) });
    const g = SC.google[cid];
    if (query.includes('FROM customer ')) return json({ results: [{ customer: { status: g.status, descriptiveName: g.name, currencyCode: 'ARS', timeZone: 'America/Argentina/Buenos_Aires' } }] });
    if (query.includes('FROM ad_group_ad')) return json({ results: [] });
    if (query.includes('segments.date BETWEEN')) {
      const [, s, u] = query.match(/BETWEEN '([\d-]+)' AND '([\d-]+)'/);
      return json({ results: daysBetween(s, u).map(d => ({ campaign: { id: cid + '01', name: 'Search Marca' }, segments: { date: d },
        metrics: { costMicros: String(g.spend(d) * 1e6), impressions: '1000', clicks: '50', conversions: g.conv, conversionsValue: 0, searchBudgetLostImpressionShare: g.lostIS ?? 0 } })) });
    }
    if (query.includes('FROM campaign')) return json({ results: [{ campaign: { id: cid + '01', name: 'Search Marca', status: 'ENABLED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CONVERSIONS', primaryStatus: 'ELIGIBLE' }, campaignBudget: { amountMicros: String(600e6) } }] });
  }
  if (url.hostname === 'api.anthropic.com') { sent.anthropic++; return json({ content: [{ text: '{"cierre":"Cierra en 95%","insight":"Meta sostiene el ritmo","accion":"Subir 10% Google","riesgo":"bajo"}' }] }); }
  if (url.hostname === 'api.resend.com') { sent.email.push(JSON.parse(opts.body)); return json({ id: 'e1' }); }
  if (url.hostname === 'hooks.slack.com') { sent.slack.push(JSON.parse(opts.body)); return json({}); }
  throw new Error('mock: host no simulado ' + url.hostname);
};

const { db, q } = require('../lib/db');
const jobs = require('../lib/jobs');
const { computeState, pacing } = require('../lib/engine');

(async () => {
  // Base limpia
  await q(db().from('metrics_daily').delete().gte('date', '1900-01-01'));
  await q(db().from('ai_insights').delete().gte('date', '1900-01-01'));
  for (const t of ['alerts', 'notification_log', 'campaigns', 'budgets', 'ad_accounts', 'clients', 'sync_runs', 'notification_channels'])
    await q(db().from(t).delete().not('id', 'is', null));

  // 1) Pacing puro
  const w = { mtd: { spend: 15000 }, today: { spend: 0 }, last7: { spend: 7000 } };
  const pc = pacing(30000, w, '2026-10-16');
  assert.strictEqual(pc.days_elapsed, 15); assert.strictEqual(pc.ideal_pct, 48.4); assert.strictEqual(pc.pct, 50);
  assert.strictEqual(pacing(30000, w, '2026-10-01').days_elapsed, 30, 'el día 1 evalúa el mes cerrado');
  console.log('✓ pacing: días transcurridos correctos (hasta ayer)');
  {
    const { buildAlerts } = require('../lib/engine');
    const mk = (spend, budget, day) => {
      const t = `2026-10-${String(day).padStart(2, '0')}`;
      const win = { mtd: { spend }, today: { spend: 0 }, last7: { spend: spend / (day - 1) * 7 } };
      return { accounts: [], campMetrics: [], clients: [{ id: 'c', name: 'X', currency: 'ARS', client_type: 'general', targets: {},
        platforms: { meta: { pacing: pacing(budget, win, t), perf: { last7: { spend: 0 }, prev7: {} } } }, total: { pacing: pacing(null, win, t), explicit_budget: false } }] };
    };
    const over = buildAlerts(mk(11000, 20000, 11), {});   // 55% gastado con 32% del mes → +22 pp
    assert.strictEqual(over[0].rule_key, 'pacing_over'); assert.strictEqual(over[0].severity, 'critical');
    assert.ok(over[0].message.includes('se agota el'), over[0].message);
    const under = buildAlerts(mk(4000, 20000, 16), {});   // 20% con 48% del mes
    assert.strictEqual(under[0].rule_key, 'pacing_under'); assert.ok(under[0].message.includes('/día'));
    const fine = buildAlerts(mk(10000, 20000, 16), {});
    assert.strictEqual(fine.length, 0);
    const early = buildAlerts(mk(5000, 20000, 3), {});  // día 2 cerrado: muy temprano para juzgar
    assert.strictEqual(early.length, 0);
    console.log('✓ reglas de ritmo: sobreinversión, bajo consumo, en ritmo y comienzo de mes');
  }

  // 2) Sin cuentas cargadas: el sync no importa nada
  let r = await jobs.dailyJob();
  assert.strictEqual((await q(db().from('ad_accounts').select('id'))).length, 0);
  assert.strictEqual(r.sync.accounts, 0);
  console.log('✓ sin importación automática: 0 cuentas hasta cargarlas a mano');

  // 3) Clientes, alta manual de cuentas vía API y presupuestos
  const [A] = await q(db().from('clients').insert({ name: 'Cliente A', slug: 'cliente-a', client_type: 'ecommerce', target_roas: 5, target_cpa: 400 }).select());
  const [B] = await q(db().from('clients').insert({ name: 'Cliente B', slug: 'cliente-b', client_type: 'leads', target_cpl: 1000 }).select());
  const { app } = require('../server');
  let TOK = '';
  const srv = app.listen(0); const base = `http://localhost:${srv.address().port}/api`;
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOK }, body: body && JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  TOK = (await call('/login', 'POST', { password: 'prueba-segura-123' }))[1].token;
  const add = async (platform, external_id, client_id) => { const [st, d] = await call('/accounts', 'POST', { platform, external_id, client_id }); assert.strictEqual(st, 200, JSON.stringify(d)); return d; };
  let d = await add('meta', '1', A.id);                 // "1" → act_1
  assert.strictEqual(d.account.external_id, 'act_1'); assert.strictEqual(d.account.name, 'Cliente A — Meta'); assert.strictEqual(d.warning, null);
  await add('google_ads', '111-111-1111', A.id);
  await add('meta', 'act_3', B.id);
  await add('google_ads', '2222222222', B.id);
  d = await add('meta', 'act_2', null);                  // sin cliente
  assert.strictEqual(d.account.status, 'DISABLED');
  let [st, err] = await call('/accounts', 'POST', { platform: 'google_ads', external_id: '123' });
  assert.strictEqual(st, 400); assert.ok(err.error.includes('10 dígitos'));
  [st, err] = await call('/accounts', 'POST', { platform: 'meta', external_id: '1' });
  assert.strictEqual(st, 400); assert.ok(err.error.includes('ya está cargada'));
  d = await add('meta', 'act_77', null);                 // sin permisos → se guarda con aviso
  assert.ok(d.warning && d.warning.includes('No se pudo leer'));
  [st] = await call('/accounts/' + d.account.id, 'DELETE');
  assert.strictEqual(st, 200);
  srv.close();
  await new Promise(res => setTimeout(res, 300)); // primeras cargas en segundo plano
  const accs = await q(db().from('ad_accounts').select('*'));
  assert.strictEqual(accs.length, 5);
  console.log('✓ alta manual: normaliza IDs, trae nombre y estado, valida duplicados/formato, avisa si no hay acceso');
  const month = Y.slice(0, 8) + '01';
  await q(db().from('budgets').insert([
    { client_id: A.id, platform: 'meta', month, amount: 20000 },      // gasta 1000/día → sobreinversión
    { client_id: A.id, platform: 'google_ads', month, amount: 15000 },
    { client_id: B.id, platform: null, month, amount: 60000 },        // total combinado, bajo consumo
  ]));

  // 4) Sync completo con cuentas monitoreadas
  r = await jobs.dailyJob();
  assert.strictEqual(r.status, 'ok', JSON.stringify(r));
  assert.strictEqual(r.sync.ok, 5);
  const alerts = await q(db().from('alerts').select('*').eq('status', 'open'));
  const keys = alerts.map(a => a.rule_key).sort();
  console.log('  alertas:', keys.join(', '));
  for (const k of ['account_disabled', 'zero_spend', 'disapproved_ads', 'pacing_under', 'high_frequency', 'budget_limited', 'no_conversions'])
    assert.ok(keys.includes(k), 'falta alerta ' + k);
  assert.ok(keys.includes('pacing_over') || keys.includes('budget_exhausted'), 'Cliente A Meta debería estar sobreinvertido o agotado');
  const dis = alerts.find(a => a.rule_key === 'account_disabled');
  assert.ok(dis.message.includes('Pago pendiente'), dis.message);
  assert.strictEqual(sent.slack.length, 1, 'un solo mensaje de Slack con todo');
  assert.ok(!sent.slack[0].blocks[1].text.text.includes('Info'), 'Slack no recibe las de nivel info');
  assert.strictEqual(sent.anthropic, 2);
  console.log(`✓ sync completo: ${alerts.length} alertas, 1 mensaje de Slack, ${sent.anthropic} insights IA`);

  // 5) Repetir: no se vuelve a avisar lo mismo
  r = await jobs.dailyJob();
  assert.strictEqual(sent.slack.length, 1, 'no debe repetir avisos');
  assert.strictEqual((await q(db().from('alerts').select('id').eq('status', 'open'))).length, alerts.length);
  console.log('✓ segunda corrida: 0 avisos repetidos, sin alertas duplicadas');

  // 6) Se arregla la cuenta caída → la alerta se resuelve sola
  SC.meta.act_2.status = 1;
  r = await jobs.criticalJob();
  const dis2 = await q(db().from('alerts').select('status').eq('id', dis.id));
  assert.strictEqual(dis2[0].status, 'resolved');
  const stillPacing = await q(db().from('alerts').select('id').eq('status', 'open').eq('rule_key', 'pacing_under'));
  assert.ok(stillPacing.length, 'el chequeo crítico no debe resolver alertas fuera de su alcance');
  console.log('✓ chequeo de urgencias: resuelve la cuenta reactivada y no toca las demás');

  // 7) Resumen por mail
  r = await jobs.digestJob({ force: true });
  assert.ok(r.digest.ok, JSON.stringify(r));
  const mail = sent.email.at(-1);
  assert.deepStrictEqual(mail.to, ['juan@doctanexus.com']);
  fs.writeFileSync(path.join(__dirname, 'digest-preview.html'), mail.html);
  console.log('✓ resumen diario enviado a', mail.to.join(', '), '—', mail.subject);

  // 8) Estado del panel
  const state = await computeState();
  const cA = state.clients.find(c => c.name === 'Cliente A');
  assert.ok(cA.platforms.meta && cA.platforms.google_ads);
  assert.strictEqual(cA.total.pacing.budget, 35000, 'total = suma de plataformas');
  const cB = state.clients.find(c => c.name === 'Cliente B');
  assert.strictEqual(cB.total.pacing.budget, 60000);
  console.log(`✓ panel: Cliente A Meta ${cA.platforms.meta.pacing.pct}% (ideal ${cA.platforms.meta.pacing.ideal_pct}%), total ${cA.total.pacing.pct}%`);

  console.log('\nTODO OK');
  process.exit(0);
})().catch(e => { console.error('✗', e); process.exit(1); });
