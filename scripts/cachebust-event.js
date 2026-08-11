'use strict';

/**
 * Post-build script for CardByte event handler cache busting.
 *
 * Files processed:
 *
 * event-handler.js
 *   → WebView runtime (OWA, New Outlook, Mac, Mobile)
 *
 * event-handler-classic.js
 *   → JS-only runtime (Classic Outlook on Windows)
 *
 * Versioning:
 *
 * Default:
 *   patch → 0.0.1 → 0.0.2
 *
 * BUMP=minor:
 *   minor → 0.1.0
 *
 * BUMP=major:
 *   major → 1.0.0
 *
 * Usage:
 *
 * node scripts/cachebust-event.js
 * BUMP=minor node scripts/cachebust-event.js
 * BUMP=major node scripts/cachebust-event.js
 *
 * Build:
 *
 * "build": "node scripts/build.js && node scripts/cachebust-event.js"
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────

const BUILD_DIR = process.env.BUILD_PATH || 'build';

const VERSION_TRACKER = path.resolve(
  __dirname,
  '..',
  'runtime-version.json'
);

const RUNTIME_DIR = path.resolve(
  BUILD_DIR,
  'runtime'
);

// ─────────────────────────────────────────────────────────
// Files to cache-bust
// ─────────────────────────────────────────────────────────

const FILES = [
  {
    name: 'event-handler',
    source: path.resolve(
      BUILD_DIR,
      'static/js/event-handler.js'
    ),
    altSource: path.resolve(
      'public/static/js/event-handler.js'
    ),
    label: 'WebView handler  ',
  },

  {
    name: 'event-handler-classic',
    source: path.resolve(
      BUILD_DIR,
      'static/js/event-handler-classic.js'
    ),
    altSource: path.resolve(
      'public/static/js/event-handler-classic.js'
    ),
    label: 'Classic handler ',
  },
];

// ─────────────────────────────────────────────────────────
// Resolve sources
// ─────────────────────────────────────────────────────────

for (const file of FILES) {
  if (fs.existsSync(file.source)) {
    continue;
  }

  if (fs.existsSync(file.altSource)) {
    console.log(
      `[cachebust] ${file.name}.js not in build/, copying from public/...`
    );

    const destDir = path.resolve(
      BUILD_DIR,
      'static/js'
    );

    fs.mkdirSync(destDir, {
      recursive: true,
    });

    fs.copyFileSync(
      file.altSource,
      file.source
    );

    continue;
  }

  console.error(
    `[cachebust] ❌ ${file.name}.js not found.`
  );

  console.error(
    `[cachebust]    Expected at: ${file.source}`
  );

  console.error(
    `[cachebust]    Alt checked: ${file.altSource}`
  );

  process.exit(1);
}

// ─────────────────────────────────────────────────────────
// Read current version
// ─────────────────────────────────────────────────────────

let versionData;

if (fs.existsSync(VERSION_TRACKER)) {
  try {
    versionData = JSON.parse(
      fs.readFileSync(
        VERSION_TRACKER,
        'utf8'
      )
    );
  } catch (error) {
    console.warn(
      '[cachebust] Could not parse runtime-version.json, resetting...'
    );

    versionData = {
      major: 0,
      minor: 0,
      patch: 0,
    };
  }
} else {
  versionData = {
    major: 0,
    minor: 0,
    patch: 0,
  };
}

// ─────────────────────────────────────────────────────────
// Increment version
// ─────────────────────────────────────────────────────────

const bumpType = (
  process.env.BUMP || 'patch'
).toLowerCase();

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

const version =
  `${versionData.major}.${versionData.minor}.${versionData.patch}`;

// ─────────────────────────────────────────────────────────
// Save updated version
// ─────────────────────────────────────────────────────────

fs.writeFileSync(
  VERSION_TRACKER,
  JSON.stringify(
    versionData,
    null,
    2
  ) + '\n'
);

// ─────────────────────────────────────────────────────────
// Create runtime directory
// ─────────────────────────────────────────────────────────

fs.mkdirSync(
  RUNTIME_DIR,
  {
    recursive: true,
  }
);

// ─────────────────────────────────────────────────────────
// Process files
// ─────────────────────────────────────────────────────────

const processed = [];

for (const file of FILES) {
  const versionedFileName =
    `${file.name}.${version}.js`;

  const versionedPath =
    path.resolve(
      RUNTIME_DIR,
      versionedFileName
    );

  const fallbackPath =
    path.resolve(
      RUNTIME_DIR,
      `${file.name}.js`
    );

  // Versioned file
  fs.copyFileSync(
    file.source,
    versionedPath
  );

  // Stable fallback
  fs.copyFileSync(
    file.source,
    fallbackPath
  );

  processed.push({
    ...file,
    versionedFileName,
  });
}

// ─────────────────────────────────────────────────────────
// Write version.json
// ─────────────────────────────────────────────────────────

const runtimeVersion = {
  version,
  timestamp: new Date().toISOString(),

  file:
    `event-handler.${version}.js`,

  fileClassic:
    `event-handler-classic.${version}.js`,
};

fs.writeFileSync(
  path.resolve(
    RUNTIME_DIR,
    'version.json'
  ),
  JSON.stringify(
    runtimeVersion,
    null,
    2
  ) + '\n'
);

// ─────────────────────────────────────────────────────────
// Write Nginx redirect configs
// ─────────────────────────────────────────────────────────

// Modern / WebView
fs.writeFileSync(
  path.resolve(
    RUNTIME_DIR,
    'event-handler-redirect.conf'
  ),
  `return 302 /runtime/event-handler.${version}.js;\n`
);

// Classic Outlook
fs.writeFileSync(
  path.resolve(
    RUNTIME_DIR,
    'classic-redirect.conf'
  ),
  `return 302 /runtime/event-handler-classic.${version}.js;\n`
);

// ─────────────────────────────────────────────────────────
// Write .well-known
// ─────────────────────────────────────────────────────────

const WELL_KNOWN_DIR = path.resolve(
  BUILD_DIR,
  '.well-known'
);

fs.mkdirSync(
  WELL_KNOWN_DIR,
  {
    recursive: true,
  }
);

fs.writeFileSync(
  path.resolve(WELL_KNOWN_DIR, 'microsoft-officeaddins-allowed.json'),
  JSON.stringify({ allowed: ['https://ns-signature.cardbyte.ai/runtime/event-handler-classic.js'] }, null, 2) + '\n'
);

// ─────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────

console.log(
  '[cachebust] ✅ Cache busting complete:'
);

console.log(
  `  Version:    ${version} (${bumpType} bump)`
);

for (const file of processed) {
  console.log(
    `  ${file.label}versioned: runtime/${file.versionedFileName}`
  );

  console.log(
    `  ${file.label}fallback:  runtime/${file.name}.js`
  );
}

console.log(
  '  Manifest:   runtime/version.json'
);

console.log(
  `  WebView redirect: runtime/event-handler-redirect.conf → event-handler.${version}.js`
);

console.log(
  `  Classic redirect: runtime/classic-redirect.conf → event-handler-classic.${version}.js`
);

console.log(
  `  Timestamp:  ${runtimeVersion.timestamp}`
);