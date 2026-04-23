#!/usr/bin/env node
/**
 * setup-check.js
 * Verifie que tous les secrets et dependances sont presents.
 * Usage: npm run setup
 *
 * Jarvis One — Groupe Genevoise
 */
const fs = require('fs');
const path = require('path');
const { PATHS, readJSONSafe, getSiteList, logger } = require('./seo-shared');

const REQUIRED_SECRETS = [
  { name: 'sanity', key: 'token', description: 'Sanity CMS token' },
  { name: 'semrush', key: 'api_key', description: 'Semrush API key' },
  { name: 'resend', key: 'api_key', description: 'Resend email API key' },
  { name: 'google-oauth', key: 'web', description: 'Google OAuth2 credentials' },
];

const OPTIONAL_SECRETS = [
  {
    name: 'anthropic',
    key: 'api_key',
    description: 'Anthropic API key (ou env ANTHROPIC_API_KEY)',
  },
  {
    name: 'bfl',
    key: 'api_key',
    fallbackKey: 'BFL_API_KEY',
    description: 'BFL Flux API key (ou env BFL_API_KEY)',
  },
  { name: 'microsoft-graph', key: 'client_id', description: 'Microsoft Graph (futur)' },
];

console.log('========================================');
console.log('  Jarvis SEO — Setup Check');
console.log('========================================\n');

let ok = 0,
  warnings = 0,
  missing = 0;

// Check required secrets
console.log('  Secrets requis:');
for (const s of REQUIRED_SECRETS) {
  const fp = path.join(PATHS.secrets, `${s.name}.json`);
  if (!fs.existsSync(fp)) {
    console.log(`  ✗ secrets/${s.name}.json — MANQUANT (${s.description})`);
    missing++;
    continue;
  }
  const data = readJSONSafe(fp, null);
  if (!data) {
    console.log(`  ✗ secrets/${s.name}.json — JSON INVALIDE`);
    missing++;
  } else if (!data[s.key]) {
    console.log(`  ! secrets/${s.name}.json — champ "${s.key}" vide`);
    warnings++;
  } else {
    console.log(`  ✓ secrets/${s.name}.json`);
    ok++;
  }
}

// Check optional secrets (with env fallback)
console.log('\n  Secrets optionnels:');
for (const s of OPTIONAL_SECRETS) {
  const fp = path.join(PATHS.secrets, `${s.name}.json`);
  const envKey =
    s.name === 'anthropic' ? 'ANTHROPIC_API_KEY' : s.name === 'bfl' ? 'BFL_API_KEY' : null;
  const hasEnv = envKey && process.env[envKey];

  if (hasEnv) {
    console.log(`  ✓ ${envKey} (variable d'environnement)`);
    ok++;
  } else if (fs.existsSync(fp)) {
    const data = readJSONSafe(fp, null);
    const val = data && (data[s.key] || (s.fallbackKey && data[s.fallbackKey]));
    if (val) {
      console.log(`  ✓ secrets/${s.name}.json`);
      ok++;
    } else {
      console.log(`  ! secrets/${s.name}.json — champ "${s.key}" vide (${s.description})`);
      warnings++;
    }
  } else {
    console.log(`  ~ secrets/${s.name}.json — absent (${s.description})`);
    warnings++;
  }
}

// Check sites config
console.log('\n  Configuration:');
const sites = getSiteList();
if (sites.length > 0) {
  console.log(`  ✓ sites/config.json — ${sites.length} sites: ${sites.join(', ')}`);
  ok++;
} else {
  console.log('  ✗ sites/config.json — aucun site configure');
  missing++;
}

// Check Node.js version
const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
if (nodeVersion >= 18) {
  console.log(`  ✓ Node.js ${process.versions.node}`);
  ok++;
} else {
  console.log(`  ✗ Node.js ${process.versions.node} — requis: 18+`);
  missing++;
}

// Check optional dependencies
console.log('\n  Dependances optionnelles:');
try {
  require('better-sqlite3');
  console.log('  ✓ better-sqlite3');
  ok++;
} catch {
  console.log('  ~ better-sqlite3 — absent (JSON fallback actif)');
  warnings++;
}

try {
  require('sharp');
  console.log('  ✓ sharp');
  ok++;
} catch {
  console.log('  ~ sharp — absent (post-traitement images desactive)');
  warnings++;
}

// Summary
const total = REQUIRED_SECRETS.length + OPTIONAL_SECRETS.length + 3; // +3 for config, node, deps
console.log(`\n========================================`);
console.log(`  ${ok}/${total} OK | ${warnings} avertissements | ${missing} manquant(s)`);
if (missing > 0) {
  console.log('  ✗ Configuration incomplete — corrigez les elements manquants');
} else if (warnings > 0) {
  console.log('  ! Pret avec avertissements');
} else {
  console.log('  ✓ Tout est pret');
}
console.log('========================================\n');

process.exit(missing > 0 ? 1 : 0);
