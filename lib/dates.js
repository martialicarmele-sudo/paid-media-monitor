'use strict';
// Fechas siempre en hora argentina (el servidor de Render corre en UTC:
// sin esto, después de las 21 hs "hoy" pasaba a ser mañana).
const TZ = process.env.TIMEZONE || 'America/Argentina/Buenos_Aires';

function todayStr(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function hourNow(now = new Date()) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now), 10) % 24;
}

// Aritmética sobre 'YYYY-MM-DD' en UTC puro (sin corrimientos de huso)
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthStart(dateStr) { return dateStr.slice(0, 8) + '01'; }

function daysInMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayOfMonth(dateStr) { return parseInt(dateStr.slice(8, 10), 10); }

function monthEnd(dateStr) { return dateStr.slice(0, 8) + String(daysInMonth(dateStr)).padStart(2, '0'); }

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

module.exports = { TZ, todayStr, hourNow, addDays, monthStart, daysInMonth, dayOfMonth, monthEnd, fmtDate };
