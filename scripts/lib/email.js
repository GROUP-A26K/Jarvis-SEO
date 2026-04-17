/**
 * lib/email.js
 * Envoi d'emails via Resend API.
 *
 * La cle et l'adresse expediteur sont lues depuis secrets/resend.json
 * (champs api_key et from). La liste de destinataires EMAIL_RECIPIENTS
 * vient de constants.js (elle-meme lue depuis process.env au chargement).
 *
 * Depend de constants.js, secrets.js, http.js.
 */

const { EMAIL_RECIPIENTS, TIMEOUTS } = require('./constants');
const { loadSecret } = require('./secrets');
const { httpRequest } = require('./http');

async function sendEmail(subject, html, attachments) {
  const resend = loadSecret('resend');
  const payload = { from: resend.from, to: EMAIL_RECIPIENTS, subject, html };
  if (attachments) payload.attachments = attachments;
  return httpRequest('https://api.resend.com/emails', {
    method: 'POST',
    timeout: TIMEOUTS.email,
    headers: {
      Authorization: `Bearer ${resend.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

module.exports = { sendEmail };
