/**
 * Ride — Icon & Asset Generator
 *
 * Renders all PNG/WebP variants from the master SVG icon.
 *
 * Prerequisites:
 *   npm install --save-dev sharp
 *
 * Usage:
 *   node scripts/generate-icons.js
 *
 * Outputs (public/icons/):
 *   icon-192.png, icon-512.png     — PWA manifest icons (with bg)
 *   ride-logo-32.png               — Favicon 32px
 *   ride-logo-48.png               — Favicon 48px
 *   ride-logo.png                  — Topbar logo 64px
 *   ride-logo.webp                 — Topbar logo 64px (WebP)
 *   ride-logo-light.png            — Medium mark 128px
 *   ride-logo-light.webp           — Medium mark 128px (WebP)
 *   og-ride.png                    — Social card 1200x630
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');
const ICON_SVG = path.join(ICONS_DIR, 'icon.svg');
const OG_SVG = path.join(ICONS_DIR, 'og-default.svg');

const VARIANTS = [
  // PWA manifest
  { name: 'icon-192.png', size: 192, format: 'png' },
  { name: 'icon-512.png', size: 512, format: 'png' },
  // Favicons
  { name: 'ride-logo-32.png', size: 32, format: 'png' },
  { name: 'ride-logo-48.png', size: 48, format: 'png' },
  // Topbar
  { name: 'ride-logo.png', size: 64, format: 'png' },
  { name: 'ride-logo.webp', size: 64, format: 'webp' },
  // Medium
  { name: 'ride-logo-light.png', size: 128, format: 'png' },
  { name: 'ride-logo-light.webp', size: 128, format: 'webp' },
];

async function generateIcons() {
  const svgBuffer = fs.readFileSync(ICON_SVG);

  console.log('Generating icon variants from icon.svg ...\n');

  for (const v of VARIANTS) {
    const outPath = path.join(ICONS_DIR, v.name);
    let pipeline = sharp(svgBuffer, { density: 300 })
      .resize(v.size, v.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });

    if (v.format === 'webp') {
      pipeline = pipeline.webp({ quality: 90 });
    } else {
      pipeline = pipeline.png({ compressionLevel: 9 });
    }

    await pipeline.toFile(outPath);
    console.log(`  ✓  ${v.name}  (${v.size}×${v.size} ${v.format})`);
  }

  // OG image (social card)
  if (fs.existsSync(OG_SVG)) {
    const ogBuffer = fs.readFileSync(OG_SVG);
    const ogOut = path.join(ICONS_DIR, 'og-ride.png');
    await sharp(ogBuffer, { density: 150 })
      .resize(1200, 630, { fit: 'contain', background: { r: 15, g: 23, b: 42, alpha: 1 } })
      .png({ compressionLevel: 9 })
      .toFile(ogOut);
    console.log(`  ✓  og-ride.png  (1200×630 png)`);
  }

  console.log('\nDone. All assets written to public/icons/');
}

generateIcons().catch(err => {
  console.error('Generation failed:', err.message);
  process.exit(1);
});
