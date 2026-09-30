'use strict';
// Motor de análisis: pacing, proyección, rendimiento y alertas.
// Lee SOLO de Supabase (la foto que guarda el sync), así el panel es rápido.
const { db, q, getSetting } = require('./db');
const { todayStr, addDays, monthStart, daysInMonth, dayOfMonth, fmtDate, hourNow } = require('./dates');

const PLATFORMS = ['meta', 'google_ads'];
const PLATFORM_LABEL = { meta: 'Meta Ads', google_ads: 'Google Ads', total: 'Total' };
const ACTIVE_ACCOUNT = { meta: ['ACTIVE', 'ANY_ACTIVE'], google_ads: ['ENABLED'] };
const ACTIVE_CAMPAIGN = { meta: ['ACTIVE'], google_ads: ['ENABLED'] };
const SEV_RANK = { info: 0, warning: 1, critical: 2 };

// PostgREST corta en 1000 filas por request: paginar
async function selectAll(build, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const rows = await q(build().range(from, from + page - 1));
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const money = (n, cur) => `${cur || ''} ${Math.round(n || 0).toLocaleString('es-AR')}`.trim();

async function loadData(today) {
  const y = addDays(today, -1);
  const from = [monthStart(y), addDays(y, -13)].sort()[0];
  const month = monthStart(y);
  const [clients, accounts, budgets, campaigns] = await Promise.all([
    q(db().from('clients').select('*').eq('active', true).order('name')),
    q(db().from('ad_accounts').select('*').eq('monitored', true)),
    q(db().from('budgets').select('*').eq('month', month)),
    selectAll(() => db().from('campaigns').select('account_id,external_id,name,status,daily_budget').order('external_id')),
  ]);
  const ids = accounts.map(a => a.id);
  const metrics = ids.length ? await selectAll(() => db().from('metrics_daily')
    .select('account_id,date,spend,impressions,clicks,conversions,conv_value,leads,purchases')
    .eq('level', 'account').in('account_id', ids).gte('date', from).lte('date', today).order('date')) : [];
  const googleIds = accounts.filter(a => a.platform === 'google_ads').map(a => a.id);
  const campMetrics = googleIds.length ? await selectAll(() => db().from('metrics_daily')
    .select('account_id,entity_id,entity_name,spend,extra')
    .eq('level', 'campaign').in('account_id', googleIds).gte('date', addDays(y, -6)).lte('date', y).order('date')) : [];
  return { clients, accounts, budgets, campaigns, metrics, campMetrics, month };
}

function emptyAgg() { return { spend: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0, leads: 0, purchases: 0 }; }
function addAgg(a, r) { for (const k of Object.keys(a)) a[k] += Number(r[k] || 0); return a; }

// Resumen de una cuenta por ventanas de tiempo
function accountWindows(rows, today) {
  const y = addDays(today, -1);
  const ms = monthStart(y);
  const w = { mtd: emptyAgg(), today: emptyAgg(), yesterday: emptyAgg(), last7: emptyAgg(), prev7: emptyAgg(), prior6: emptyAgg(), daily: {} };
  for (const r of rows) {
    const d = r.date;
    w.daily[d] = (w.daily[d] || 0) + Number(r.spend || 0);
    if (d === today) addAgg(w.today, r);
    if (d === y) addAgg(w.yesterday, r);
    if (d >= ms && d <= y) addAgg(w.mtd, r);
    if (d >= addDays(y, -6) && d <= y) addAgg(w.last7, r);
    if (d >= addDays(y, -13) && d <= addDays(y, -7)) addAgg(w.prev7, r);
    if (d >= addDays(y, -6) && d < y) addAgg(w.prior6, r);
  }
  return w;
}

function mergeWindows(list) {
  const out = { mtd: emptyAgg(), today: emptyAgg(), yesterday: emptyAgg(), last7: emptyAgg(), prev7: emptyAgg(), prior6: emptyAgg(), daily: {} };
  for (const w of list) {
    for (const k of ['mtd', 'today', 'yesterday', 'last7', 'prev7', 'prior6']) addAgg(out[k], w[k]);
    for (const [d, s] of Object.entries(w.daily)) out.daily[d] = (out.daily[d] || 0) + s;
  }
  return out;
}

// Pacing contra presupuesto. El gasto del mes se cuenta hasta AYER
// (día cerrado) y se compara contra los días transcurridos hasta ayer.
function pacing(budget, w, today) {
  const y = addDays(today, -1);
  const dim = daysInMonth(y);
  const elapsed = dayOfMonth(today) === 1 ? dim : dayOfMonth(y); // el día 1 se evalúa el mes que cerró
  const remaining = dim - elapsed;
  const spend = w.mtd.spend;
  const avg7 = w.last7.spend / 7;
  const projected = spend + avg7 * remaining;
  const res = {
    budget: budget ?? null, spend_mtd: round(spend), spend_today: round(w.today.spend), avg_daily_7d: round(avg7),
    projected: round(projected), days_elapsed: elapsed, days_in_month: dim, days_remaining: remaining,
  };
  if (!budget) return { ...res, status: 'no_budget' };
  res.pct = round((spend / budget) * 100, 1);
  res.ideal_pct = round((elapsed / dim) * 100, 1);
  res.deviation_pp = round(res.pct - res.ideal_pct, 1);
  res.projected_pct = round((projected / budget) * 100, 1);
  res.remaining_budget = round(budget - spend);
  res.ideal_daily = remaining > 0 ? round(Math.max(0, budget - spend) / remaining) : null;
  if (avg7 > 0 && spend < budget) {
    const daysToExhaust = (budget - spend) / avg7;
    if (daysToExhaust < remaining) res.exhaust_date = addDays(y, Math.ceil(daysToExhaust));
  }
  return res;
}

function perf(w, clientType, platform) {
  const conv = win => (clientType === 'leads' && platform === 'meta' ? win.leads
    : clientType === 'ecommerce' && platform === 'meta' ? win.purchases : win.conversions);
  const mk = win => {
    const c = conv(win);
    return {
      spend: round(win.spend), conversions: round(c, 1), value: round(win.conv_value),
      cpa: c > 0 ? round(win.spend / c) : null,
      roas: win.spend > 0 && win.conv_value > 0 ? round(win.conv_value / win.spend) : null,
      ctr: win.impressions > 0 ? round((win.clicks / win.impressions) * 100) : null,
      cpm: win.impressions > 0 ? round((win.spend / win.impressions) * 1000) : null,
    };
  };
  return { mtd: mk(w.mtd), last7: mk(w.last7), prev7: mk(w.prev7) };
}

// ── Estado completo (lo usa el panel y el motor de alertas) ─────────
async function computeState(today = todayStr()) {
  const data = await loadData(today);
  const byAccount = new Map();
  for (const r of data.metrics) {
    if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, []);
    byAccount.get(r.account_id).push(r);
  }
  const activeCamps = new Map();
  for (const c of data.campaigns) {
    const acc = data.accounts.find(a => a.id === c.account_id);
    if (acc && ACTIVE_CAMPAIGN[acc.platform]?.includes(c.status)) activeCamps.set(c.account_id, (activeCamps.get(c.account_id) || 0) + 1);
  }

  const accounts = data.accounts.map(a => {
    const w = accountWindows(byAccount.get(a.id) || [], today);
    return { ...a, windows: w, active_campaigns: activeCamps.get(a.id) || 0 };
  });

  const clients = data.clients.map(c => {
    const accs = accounts.filter(a => a.client_id === c.id);
    const budgets = data.budgets.filter(b => b.client_id === c.id);
    const byPlatform = {};
    for (const p of PLATFORMS) {
      const pAccs = accs.filter(a => a.platform === p);
      const b = budgets.find(x => x.platform === p);
      if (!pAccs.length && !b) continue;
      const w = mergeWindows(pAccs.map(a => a.windows));
      byPlatform[p] = { pacing: pacing(b ? Number(b.amount) : null, w, today), perf: perf(w, c.client_type, p), accounts: pAccs.length, daily: w.daily };
    }
    const totalBudgetRow = budgets.find(x => x.platform == null);
    const platformBudgetSum = budgets.filter(x => x.platform).reduce((s, x) => s + Number(x.amount), 0);
    const totalW = mergeWindows(accs.map(a => a.windows));
    const total = {
      pacing: pacing(totalBudgetRow ? Number(totalBudgetRow.amount) : (platformBudgetSum || null), totalW, today),
      explicit_budget: !!totalBudgetRow,
      daily: totalW.daily,
    };
    return {
      id: c.id, name: c.name, slug: c.slug, client_type: c.client_type, currency: c.currency,
      targets: { cpa: c.target_cpa, cpl: c.target_cpl, roas: c.target_roas },
      platforms: byPlatform, total,
      accounts: accs.map(a => ({ id: a.id, name: a.name, platform: a.platform, currency: a.currency, status: a.status,
        last_error: a.last_error, last_synced_at: a.last_synced_at, spend_mtd: round(a.windows.mtd.spend) })),
      _accs: accs,
    };
  });

  return { today, month: data.month, clients, accounts, campMetrics: data.campMetrics };
}

// ── Reglas de alertas ───────────────────────────────────────────────
// scope 'full' = todas; 'critical' = solo las que se revisan cada pocas horas
const CRITICAL_RULES = ['account_disabled', 'budget_exhausted', 'zero_spend_today', 'sync_error'];

function buildAlerts(state, settings, scope = 'full') {
  const warnPP = settings.pacing_warning_pp ?? 10;
  const critPP = settings.pacing_critical_pp ?? 20;
  const out = [];
  const add = (a) => { if (scope === 'full' || CRITICAL_RULES.includes(a.rule_key)) out.push(a); };
  const fp = (rule, clientId, accountId, platform) => `${rule}:${clientId || '-'}:${accountId || '-'}:${platform || '-'}`;
  const clientOf = id => state.clients.find(c => c.id === id);
  const hour = hourNow();

  // Nivel cuenta
  for (const a of state.accounts) {
    const client = clientOf(a.client_id);
    const who = `${client ? client.name + ' · ' : ''}${a.name} (${PLATFORM_LABEL[a.platform]})`;
    const base = { client_id: a.client_id || null, account_id: a.id };
    if (a.status && !ACTIVE_ACCOUNT[a.platform].includes(a.status)) {
      const reason = a.status_detail?.disable_reason ? ` — ${a.status_detail.disable_reason}` : '';
      add({ ...base, rule_key: 'account_disabled', severity: 'critical', fingerprint: fp('account_disabled', null, a.id),
        message: `${who}: cuenta en estado ${a.status}${reason}`, data: { status: a.status } });
    }
    if (a.last_error) {
      add({ ...base, rule_key: 'sync_error', severity: 'warning', fingerprint: fp('sync_error', null, a.id),
        message: `${who}: no se pudo leer la cuenta — ${a.last_error.slice(0, 160)}`, data: {} });
    }
    const disapproved = a.status_detail?.disapproved_ads || 0;
    if (disapproved > 0) {
      add({ ...base, rule_key: 'disapproved_ads', severity: 'warning', fingerprint: fp('disapproved_ads', null, a.id),
        message: `${who}: ${disapproved} anuncio${disapproved > 1 ? 's' : ''} rechazado${disapproved > 1 ? 's' : ''}`, data: { count: disapproved } });
    }
    const w = a.windows;
    if (a.active_campaigns > 0 && w.yesterday.spend === 0 && w.prior6.spend > 0) {
      add({ ...base, rule_key: 'zero_spend', severity: 'critical', fingerprint: fp('zero_spend', null, a.id),
        message: `${who}: sin gasto ayer, con ${a.active_campaigns} campaña${a.active_campaigns > 1 ? 's' : ''} activa${a.active_campaigns > 1 ? 's' : ''}`, data: {} });
    }
    if (hour >= 14 && a.active_campaigns > 0 && w.today.spend === 0 && w.yesterday.spend > 0) {
      add({ ...base, rule_key: 'zero_spend_today', severity: 'warning', fingerprint: fp('zero_spend_today', null, a.id),
        message: `${who}: sin gasto hoy hasta las ${hour} hs (ayer gastó ${money(w.yesterday.spend, a.currency)})`, data: {} });
    }
    if (a.platform === 'meta' && a.status_detail?.week) {
      const wk = a.status_detail.week;
      if (wk.last?.frequency > 4) add({ ...base, rule_key: 'high_frequency', severity: 'warning', fingerprint: fp('high_frequency', null, a.id),
        message: `${who}: frecuencia ${wk.last.frequency.toFixed(1)} en 7 días — audiencia saturada`, data: { frequency: wk.last.frequency } });
      if (wk.prev?.cpm > 0 && wk.last?.cpm > 0) {
        const d = ((wk.last.cpm - wk.prev.cpm) / wk.prev.cpm) * 100;
        if (d > 60) add({ ...base, rule_key: 'cpm_spike', severity: 'warning', fingerprint: fp('cpm_spike', null, a.id),
          message: `${who}: CPM subió ${Math.round(d)}% vs semana anterior`, data: { change_pct: round(d, 0) } });
      }
    }
  }

  // Google: campañas limitadas por presupuesto (últimos 7 días)
  const limited = new Map();
  for (const r of state.campMetrics || []) {
    const is = r.extra?.budget_lost_is;
    if (is == null || !(r.spend > 0)) continue;
    const k = r.account_id + '|' + r.entity_id;
    const cur = limited.get(k) || { account_id: r.account_id, name: r.entity_name, sum: 0, n: 0 };
    cur.sum += is; cur.n++; limited.set(k, cur);
  }
  const limByAcc = new Map();
  for (const v of limited.values()) {
    const avg = v.sum / v.n;
    if (avg >= 0.2) { if (!limByAcc.has(v.account_id)) limByAcc.set(v.account_id, []); limByAcc.get(v.account_id).push({ name: v.name, lost: Math.round(avg * 100) }); }
  }
  for (const [accId, camps] of limByAcc) {
    const a = state.accounts.find(x => x.id === accId);
    if (!a) continue;
    const client = clientOf(a.client_id);
    const top = camps.sort((x, y) => y.lost - x.lost).slice(0, 3).map(c => `${c.name} (${c.lost}%)`).join(', ');
    add({ client_id: a.client_id || null, account_id: a.id, rule_key: 'budget_limited', severity: 'info',
      fingerprint: fp('budget_limited', null, a.id),
      message: `${client ? client.name + ' · ' : ''}${a.name}: ${camps.length} campaña${camps.length > 1 ? 's' : ''} pierde${camps.length > 1 ? 'n' : ''} impresiones por presupuesto: ${top}`,
      data: { campaigns: camps } });
  }

  // Nivel cliente: pacing y rendimiento
  for (const c of state.clients) {
    const scopes = [];
    for (const [p, v] of Object.entries(c.platforms)) if (v.pacing.budget) scopes.push([p, v.pacing]);
    if (c.total.explicit_budget || !scopes.length) if (c.total.pacing.budget) scopes.push(['total', c.total.pacing]);
    for (const [p, pc] of scopes) {
      const label = `${c.name} · ${PLATFORM_LABEL[p]}`;
      const base = { client_id: c.id, account_id: null };
      const cur = c.currency;
      if (pc.spend_mtd >= pc.budget) {
        add({ ...base, rule_key: 'budget_exhausted', severity: 'critical', fingerprint: fp('budget_exhausted', c.id, null, p),
          message: `${label}: presupuesto agotado (${Math.round(pc.pct)}% — ${money(pc.spend_mtd, cur)} de ${money(pc.budget, cur)})`, data: { platform: p, ...pc } });
        continue;
      }
      if (pc.days_elapsed < 3) continue; // muy temprano en el mes para juzgar el ritmo
      const dev = pc.deviation_pp;
      const tail = pc.exhaust_date ? ` Al ritmo actual se agota el ${fmtDate(pc.exhaust_date)}.` : ` Proyección: ${Math.round(pc.projected_pct)}% del presupuesto.`;
      if (dev > critPP || dev > warnPP) {
        add({ ...base, rule_key: 'pacing_over', severity: dev > critPP ? 'critical' : 'warning', fingerprint: fp('pacing_over', c.id, null, p),
          message: `${label}: sobreinversión, +${Math.round(dev)} pp vs ideal (${Math.round(pc.pct)}% gastado, ideal ${Math.round(pc.ideal_pct)}%).${tail}`, data: { platform: p, ...pc } });
      } else if (dev < -critPP || dev < -warnPP) {
        add({ ...base, rule_key: 'pacing_under', severity: dev < -critPP ? 'critical' : 'warning', fingerprint: fp('pacing_under', c.id, null, p),
          message: `${label}: bajo consumo, ${Math.round(dev)} pp vs ideal (${Math.round(pc.pct)}% gastado, ideal ${Math.round(pc.ideal_pct)}%).${tail} Para llegar: ${money(pc.ideal_daily, cur)}/día.`, data: { platform: p, ...pc } });
      }
    }

    for (const [p, v] of Object.entries(c.platforms)) {
      const l = v.perf.last7, pv = v.perf.prev7;
      const label = `${c.name} · ${PLATFORM_LABEL[p]}`;
      const base = { client_id: c.id, account_id: null };
      const target = c.client_type === 'leads' ? c.targets.cpl : c.targets.cpa;
      if (l.spend > 0 && target && l.cpa && l.cpa > target * 1.3) {
        add({ ...base, rule_key: 'cpa_over_target', severity: 'warning', fingerprint: fp('cpa_over_target', c.id, null, p),
          message: `${label}: ${c.client_type === 'leads' ? 'CPL' : 'CPA'} de 7 días ${money(l.cpa, c.currency)} vs objetivo ${money(target, c.currency)} (+${Math.round((l.cpa / target - 1) * 100)}%)`, data: { platform: p, cpa: l.cpa, target } });
      }
      if (c.targets.roas && l.roas != null && l.roas < c.targets.roas * 0.7) {
        add({ ...base, rule_key: 'roas_below_target', severity: 'warning', fingerprint: fp('roas_below_target', c.id, null, p),
          message: `${label}: ROAS de 7 días ${l.roas} vs objetivo ${c.targets.roas}`, data: { platform: p, roas: l.roas, target: c.targets.roas } });
      }
      const minSpend = target ? target * 2 : 0;
      if (['ecommerce', 'leads'].includes(c.client_type) && l.spend > minSpend && l.spend > 0 && !l.conversions) {
        add({ ...base, rule_key: 'no_conversions', severity: 'warning', fingerprint: fp('no_conversions', c.id, null, p),
          message: `${label}: sin ${c.client_type === 'leads' ? 'leads' : 'conversiones'} en 7 días con ${money(l.spend, c.currency)} invertidos`, data: { platform: p } });
      } else if (pv.conversions >= 5 && l.conversions < pv.conversions * 0.6) {
        add({ ...base, rule_key: 'conversions_drop', severity: 'warning', fingerprint: fp('conversions_drop', c.id, null, p),
          message: `${label}: conversiones cayeron ${Math.round((1 - l.conversions / pv.conversions) * 100)}% vs semana anterior (${l.conversions} vs ${pv.conversions})`, data: { platform: p } });
      }
    }
  }
  return out;
}

// Reconciliación: crea las nuevas, actualiza las que siguen, resuelve las
// que ya no aparecen. Una alerta abierta por fingerprint → nunca se repite.
async function applyAlerts(newAlerts, scope = 'full') {
  const now = new Date().toISOString();
  const open = await q(db().from('alerts').select('*').in('status', ['open', 'snoozed']));
  const openByFp = new Map(open.map(a => [a.fingerprint, a]));
  const seen = new Set();
  const stats = { created: 0, updated: 0, escalated: 0, resolved: 0 };

  for (const a of newAlerts) {
    if (seen.has(a.fingerprint)) continue;
    seen.add(a.fingerprint);
    const ex = openByFp.get(a.fingerprint);
    if (!ex) {
      await q(db().from('alerts').insert({ ...a, first_seen_at: now, last_seen_at: now }));
      stats.created++;
      continue;
    }
    const patch = { last_seen_at: now, message: a.message, data: a.data };
    if (SEV_RANK[a.severity] > SEV_RANK[ex.severity]) { patch.severity = a.severity; patch.notified_at = null; stats.escalated++; }
    else if (SEV_RANK[a.severity] < SEV_RANK[ex.severity]) patch.severity = a.severity;
    if (ex.status === 'snoozed' && ex.snoozed_until && ex.snoozed_until < now) { patch.status = 'open'; patch.snoozed_until = null; }
    await q(db().from('alerts').update(patch).eq('id', ex.id));
    stats.updated++;
  }
  for (const ex of open) {
    if (seen.has(ex.fingerprint)) continue;
    if (scope !== 'full' && !CRITICAL_RULES.includes(ex.rule_key)) continue; // fuera del alcance de este chequeo
    await q(db().from('alerts').update({ status: 'resolved', resolved_at: now }).eq('id', ex.id));
    stats.resolved++;
  }
  return stats;
}

async function runAlerts(scope = 'full', today = todayStr()) {
  const state = await computeState(today);
  const settings = await getSetting('alerts', {});
  const alerts = buildAlerts(state, settings, scope);
  const stats = await applyAlerts(alerts, scope);
  return { ...stats, evaluated: alerts.length, state };
}

// Versión liviana para el panel (sin datos internos)
function publicState(state) {
  return {
    today: state.today, month: state.month,
    clients: state.clients.map(({ _accs, ...c }) => c),
  };
}

module.exports = { computeState, buildAlerts, applyAlerts, runAlerts, publicState, pacing, accountWindows, PLATFORM_LABEL, SEV_RANK, CRITICAL_RULES };
