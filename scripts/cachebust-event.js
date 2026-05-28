'use strict';

/**
 * Post-build script for CardByte event handler cache busting.
 *
 * How it works:
 *   1. Reads runtime-version.json from project root
 *   2. Increments the patch version (0.0.1 → 0.0.2 → 0.0.3 ...)
 *   3. Saves updated version back to runtime-version.json
 *   4. Creates build/runtime/ with versioned JS + version.json
 *
 * Files processed:
 *   event-handler.js         → WebView runtime (OWA, New Outlook, Mac, Mobile)
 *   event-handler-classic.js → JS-only runtime (Classic Outlook on Windows)
 *
 * Version bumping:
 *   - Default (every build): bumps patch   → 0.0.1 → 0.0.2
 *   - BUMP=minor:            bumps minor   → 0.1.0
 *   - BUMP=major:            bumps major   → 1.0.0
 *
 * Usage:
 *   node scripts/cachebust-event.js              → 0.0.1 → 0.0.2
 *   BUMP=minor node scripts/cachebust-event.js   → 0.0.2 → 0.1.0
 *   BUMP=major node scripts/cachebust-event.js   → 0.1.0 → 1.0.0
 *
 * Run after the main build:
 *   "build": "node scripts/build.js && node scripts/cachebust-event.js"
 */

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────
const BUILD_DIR = process.env.BUILD_PATH || 'build';
const VERSION_TRACKER = path.resolve(__dirname, '..', 'runtime-version.json');
const RUNTIME_DIR = path.resolve(BUILD_DIR, 'runtime');

// ── Files to cache-bust ─────────────────────────────────
// Each entry defines where webpack puts the file (source) and what to call
// the versioned/fallback copies in build/runtime/.
const FILES = [
  {
    name: 'event-handler',
    source: path.resolve(BUILD_DIR, 'static/js/event-handler.js'),
    altSource: path.resolve('public/static/js/event-handler.js'),
    label: 'WebView handler  ',   // spaces for aligned console output
  },
  {
    name: 'event-handler-classic',
    source: path.resolve(BUILD_DIR, 'static/js/event-handler-classic.js'),
    altSource: path.resolve('public/static/js/event-handler-classic.js'),
    label: 'Classic handler  ',
  },
];

// ── Resolve sources (build output → public fallback) ────
for (const f of FILES) {
  if (!fs.existsSync(f.source)) {
    if (fs.existsSync(f.altSource)) {
      console.log(`[cachebust] ${f.name} not in build/, copying from public/...`);
      const destDir = path.resolve(BUILD_DIR, 'static/js');
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(f.altSource, f.source);
    } else {
      console.error(`[cachebust] ❌ ${f.name}.js not found.`);
      console.error(`[cachebust]    Expected at: ${f.source}`);
      console.error(`[cachebust]    Alt checked: ${f.altSource}`);
      process.exit(1);
    }
  }
}

// ── Read current version ────────────────────────────────
let versionData;
if (fs.existsSync(VERSION_TRACKER)) {
  try {
    versionData = JSON.parse(fs.readFileSync(VERSION_TRACKER, 'utf8'));
  } catch (e) {
    console.warn('[cachebust] Could not parse runtime-version.json, resetting...');
    versionData = { major: 0, minor: 0, patch: 0 };
  }
} else {
  versionData = { major: 0, minor: 0, patch: 0 };
}

// ── Increment version ───────────────────────────────────
const bumpType = (process.env.BUMP || 'patch').toLowerCase();

switch (bumpType) {
  case 'major':
    versionData.major += 1;
    versionData.minor = 0;
    versionData.patch = 0;
    break;
  case 'minor':
    versionData.minor += 1;
    versionData.patch = 0;
    break;
  case 'patch':
  default:
    versionData.patch += 1;
    break;
}

const version = `${versionData.major}.${versionData.minor}.${versionData.patch}`;

// ── Save updated version back to tracker ────────────────
fs.writeFileSync(VERSION_TRACKER, JSON.stringify(versionData, null, 2) + '\n');

// ── Create runtime directory ────────────────────────────
fs.mkdirSync(RUNTIME_DIR, { recursive: true });

// ── Process each file ───────────────────────────────────
const processed = [];

for (const f of FILES) {
  const versionedFileName = `${f.name}.${version}.js`;
  const versionedPath = path.resolve(RUNTIME_DIR, versionedFileName);
  const fallbackPath = path.resolve(RUNTIME_DIR, `${f.name}.js`);

  fs.copyFileSync(f.source, versionedPath);   // runtime/event-handler-classic.0.0.147.js
  fs.copyFileSync(f.source, fallbackPath);    // runtime/event-handler-classic.js (always-latest)

  processed.push({ ...f, versionedFileName });
}

// ── Write version.json for runtime loader ───────────────
const runtimeVersion = {
  version,
  timestamp: new Date().toISOString(),
  // Both file entries so the loader can reference either
  file: `event-handler.${version}.js`,
  fileClassic: `event-handler-classic.${version}.js`,
};
fs.writeFileSync(
  path.resolve(RUNTIME_DIR, 'version.json'),
  JSON.stringify(runtimeVersion, null, 2)
);

// ── Write .well-known/microsoft-officeaddins-allowed.json ──
const WELL_KNOWN_DIR = path.resolve(BUILD_DIR, '.well-known');
fs.mkdirSync(WELL_KNOWN_DIR, { recursive: true });
fs.writeFileSync(
  path.resolve(WELL_KNOWN_DIR, 'microsoft-officeaddins-allowed.json'),
  JSON.stringify({ allow: ['*'] }, null, 2) + '\n'
);

// ── Summary ─────────────────────────────────────────────
console.log('[cachebust] ✅ Cache busting complete:');
console.log(`  Version:    ${version} (${bumpType} bump)`);
for (const f of processed) {
  console.log(`  ${f.label} versioned:  runtime/${f.versionedFileName}`);
  console.log(`  ${f.label} fallback:   runtime/${f.name}.js`);
}
console.log(`  Manifest:   runtime/version.json`);
console.log(`  Timestamp:  ${runtimeVersion.timestamp}`);