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
const SOURCE_JS = path.resolve(BUILD_DIR, 'static/js/event-handler.js');
const RUNTIME_DIR = path.resolve(BUILD_DIR, 'runtime');

// ── Validate source JS exists ───────────────────────────
if (!fs.existsSync(SOURCE_JS)) {
  const altSource = path.resolve('public/static/js/event-handler.js');
  if (fs.existsSync(altSource)) {
    console.log('[cachebust] Source found in public/, copying to build...');
    const destDir = path.resolve(BUILD_DIR, 'static/js');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(altSource, SOURCE_JS);
  } else {
    console.error('[cachebust] ❌ event-handler.js not found.');
    console.error('[cachebust] Expected at:', SOURCE_JS);
    process.exit(1);
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

// ── Copy versioned file ─────────────────────────────────
const versionedFileName = `event-handler.${version}.js`;
fs.copyFileSync(SOURCE_JS, path.resolve(RUNTIME_DIR, versionedFileName));

// ── Copy unversioned fallback ───────────────────────────
fs.copyFileSync(SOURCE_JS, path.resolve(RUNTIME_DIR, 'event-handler.js'));

// ── Write version.json for runtime loader ───────────────
const runtimeVersion = {
  version: version,
  file: versionedFileName,
  timestamp: new Date().toISOString()
};
fs.writeFileSync(
  path.resolve(RUNTIME_DIR, 'version.json'),
  JSON.stringify(runtimeVersion, null, 2)
);

// ── Summary ─────────────────────────────────────────────
console.log('[cachebust] ✅ Cache busting complete:');
console.log(`  Version:    ${version} (${bumpType} bump)`);
console.log(`  Versioned:  runtime/${versionedFileName}`);
console.log(`  Fallback:   runtime/event-handler.js`);
console.log(`  Manifest:   runtime/version.json`);
console.log(`  Timestamp:  ${runtimeVersion.timestamp}`);