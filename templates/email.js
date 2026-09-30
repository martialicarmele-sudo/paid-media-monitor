'use strict';
// Plantillas de mail (HTML compatible con clientes de correo: tablas + estilos inline)
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const C = { bg: '#0b0b12', card: '#14141f', line: '#262636', text: '#ecedf5', muted: '#8a8aa3', blue: '#4b47ff', orange: '#FF751F',
  critical: '#f26d6d', warning: '#f5a623', info: '#60a5fa', ok: '#5de8a0' };
const SEV = { critical: ['Crítico', C.critical], warning: ['Atención', C.warning], info: ['Info', C.info] };
const PL = { meta: 'Meta', google_ads: 'Google', total: 'Total' };
const money = (n, cur) => n == null ? '—' : `${cur ? cur + ' ' : ''}${Math.round(n).toLocaleString('es-AR')}`;

function statusColor(pc) {
  if (!pc || !pc.budget) return C.muted;
  if (pc.pct >= 100 || Math.abs(pc.deviation_pp) > 20) return C.critical;
  if (Math.abs(pc.deviation_pp) > 10) return C.warning;
  return C.ok;
}

function bar(pc) {
  if (!pc?.budget) return `<span style="color:${C.muted};font-size:12px">Sin presupuesto cargado</span>`;
  const w = Math.max(2, Math.min(100, pc.pct || 0));
  const ideal = Math.min(100, pc.ideal_pct || 0);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
    <td style="background:${C.line};border-radius:4px;height:8px;padding:0">
      <div style="width:${w}%;height:8px;background:${statusColor(pc)};border-radius:4px"></div>
    </td></tr></table>
    <div style="font-size:11px;color:${C.muted};margin-top:4px">${pc.pct >= 100
      ? `<b style="color:${C.critical}">Agotado</b> · excedido en ${money(pc.spend_mtd - pc.budget)}`
      : `${Math.round(pc.pct)}% gastado · ideal ${Math.round(ideal)}% · proyección ${Math.round(pc.projected_pct)}%${pc.exhaust_date ? ` · se agota el ${pc.exhaust_date.slice(8, 10)}/${pc.exhaust_date.slice(5, 7)}` : ''}`}</div>`;
}

function alertRows(alerts) {
  if (!alerts.length) return `<div style="color:${C.ok};font-size:13px;padding:8px 0">✓ Sin alertas abiertas.</div>`;
  const order = { critical: 0, warning: 1, info: 2 };
  return [...alerts].sort((a, b) => order[a.severity] - order[b.severity]).map(a => {
    const [label, color] = SEV[a.severity] || SEV.info;
    return `<tr><td style="padding:8px 10px;border-bottom:1px solid ${C.line};vertical-align:top;width:74px">
        <span style="display:inline-block;font-size:10px;font-weight:700;color:${color};border:1px solid ${color};border-radius:10px;padding:2px 7px">${label}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid ${C.line};font-size:13px;color:${C.text};line-height:1.5">
        ${esc(a.message)}${a.is_new ? ` <span style="font-size:10px;color:${C.orange};font-weight:700">NUEVA</span>` : ''}</td></tr>`;
  }).join('');
}

function clientBlock(c, insight) {
  const rows = [];
  for (const [p, v] of Object.entries(c.platforms || {})) {
    rows.push(`<tr><td style="padding:6px 0;font-size:12px;color:${C.muted};width:64px;vertical-align:top">${PL[p]}</td>
      <td style="padding:6px 0 6px 8px;font-size:12px;color:${C.text}">
        ${money(v.pacing.spend_mtd, c.currency)}${v.pacing.budget ? ` de ${money(v.pacing.budget, c.currency)}` : ''}
        <div style="margin-top:4px">${bar(v.pacing)}</div></td></tr>`);
  }
  if (Object.keys(c.platforms || {}).length !== 1 || c.total.explicit_budget) {
    rows.push(`<tr><td style="padding:6px 0;font-size:12px;color:${C.text};font-weight:700;vertical-align:top">Total</td>
      <td style="padding:6px 0 6px 8px;font-size:12px;color:${C.text};font-weight:700">
        ${money(c.total.pacing.spend_mtd, c.currency)}${c.total.pacing.budget ? ` de ${money(c.total.pacing.budget, c.currency)}` : ''}
        <div style="margin-top:4px">${bar(c.total.pacing)}</div></td></tr>`);
  }
  const ins = insight ? `<div style="margin-top:8px;padding:8px 10px;background:${C.bg};border-radius:6px;font-size:12px;line-height:1.5;color:${C.muted}">
      <b style="color:${C.text}">IA:</b> ${esc(insight.insight)}<br><b style="color:${C.orange}">Acción:</b> ${esc(insight.accion)}</div>` : '';
  return `<div style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:14px 16px;margin-bottom:10px">
    <div style="font-size:14px;font-weight:700;color:${C.text};margin-bottom:6px">${esc(c.name)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>${ins}</div>`;
}

function shell(title, body, appUrl) {
  return `<!doctype html><html><body style="margin:0;background:${C.bg};font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">
    <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${C.orange};font-weight:700">Docta Nexus</div>
    <div style="font-size:20px;font-weight:700;color:${C.text};margin:4px 0 18px">${esc(title)}</div>
    ${body}
    ${appUrl ? `<div style="text-align:center;margin:22px 0 6px"><a href="${esc(appUrl)}" style="background:${C.blue};color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:10px 20px;border-radius:8px;display:inline-block">Abrir el panel</a></div>` : ''}
    <div style="text-align:center;font-size:11px;color:${C.muted};margin-top:14px">Paid Media Monitor · Docta Nexus</div>
  </div></body></html>`;
}

function renderDigest({ mode, state, alerts = [], insights = {}, appUrl }) {
  if (mode === 'instant') {
    return shell('Alertas nuevas', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:${C.card};border:1px solid ${C.line};border-radius:10px">${alertRows(alerts)}</table>`, appUrl);
  }
  const crit = alerts.filter(a => a.severity === 'critical').length;
  const warn = alerts.filter(a => a.severity === 'warning').length;
  const withBudget = state.clients.filter(c => c.total.pacing.budget);
  const offPace = withBudget.filter(c => Math.abs(c.total.pacing.deviation_pp || 0) > 10 || (c.total.pacing.pct || 0) >= 100).length;
  const tile = (n, label, color) => `<td style="width:33%;padding:0 4px"><div style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:12px;text-align:center">
      <div style="font-size:22px;font-weight:700;color:${color}">${n}</div><div style="font-size:11px;color:${C.muted};margin-top:2px">${label}</div></div></td>`;
  const [y, m, d] = state.today.split('-');
  const body = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px 18px"><tr>
      ${tile(crit, 'Críticas', crit ? C.critical : C.ok)}${tile(warn, 'Atención', warn ? C.warning : C.ok)}${tile(`${offPace}/${withBudget.length}`, 'Fuera de ritmo', offPace ? C.warning : C.ok)}
    </tr></table>
    <div style="font-size:13px;font-weight:700;color:${C.text};margin:0 0 8px">Alertas abiertas</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-radius:10px;margin-bottom:20px">${alertRows(alerts)}</table>
    <div style="font-size:13px;font-weight:700;color:${C.text};margin:0 0 8px">Presupuestos del mes (al cierre de ayer)</div>
    ${state.clients.map(c => clientBlock(c, insights[c.id])).join('')}`;
  return shell(`Resumen diario · ${d}/${m}/${y}`, body, appUrl);
}

module.exports = { renderDigest };
