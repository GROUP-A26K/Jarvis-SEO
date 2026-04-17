/**
 * lib/helpers.js
 * Helpers purs : conversions, formats, utilitaires sans dependance.
 */

/**
 * Retourne l'annee et le numero de semaine ISO 8601 pour une date donnee.
 * Format : "YYYY-Wnn" (ex: "2026-W16").
 */
function getISOWeek(d) {
  const date = d ? new Date(d) : new Date();
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dn = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dn);
  const ys = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return `${utc.getUTCFullYear()}-W${String(Math.ceil(((utc - ys) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

module.exports = { getISOWeek };
