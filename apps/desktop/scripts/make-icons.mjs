// Draws every icon from the HeyBotOS mark: the Mac app icon, the menu-bar icon, and the dashboard's
// favicons. The mark's path data lives in apps/web/src/components/brand/paths.ts (from the logo
// package). Rendering is done by Chrome through Playwright, which the browser tests already use.
// Run it with `pnpm --filter @heybotos/desktop icons` after the mark changes; its output is committed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { MARK_BOX, MARK_FACE, MARK_SCREEN, MARK_SHELL, MARK_SPARKS } from '../../web/src/components/brand/paths.ts'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '..')
const web = join(desktop, '..', 'web', 'public')
const NAVY = '#0A102A'

const gradient = `<linearGradient id="g" x1="0%" y1="85%" x2="100%" y2="10%"><stop offset="0%" stop-color="#315DFB"/><stop offset="36%" stop-color="#8156F7"/><stop offset="68%" stop-color="#BB58E7"/><stop offset="100%" stop-color="#F459B4"/></linearGradient>`
/** The mark in colour. The white under the screen is what shows through its eyes, on any background. */
const mark = `<path fill="url(#g)" fill-rule="evenodd" d="${MARK_SPARKS} ${MARK_SHELL}"/><path fill="#fff" d="${MARK_SCREEN}"/><path fill="${NAVY}" fill-rule="evenodd" d="${MARK_FACE}"/>`
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX}" role="img" aria-label="HeyBotOS"><title>HeyBotOS</title><defs>${gradient}</defs>${mark}</svg>\n`

/** The mark placed in a square of `size`, `width` wide, optically centred. */
const placed = (size, width) => {
  const scale = width / 490
  const x = (size - width) / 2 - 110 * scale
  const y = (size - 505 * scale) / 2 - 110 * scale
  return `<g transform="translate(${x} ${y}) scale(${scale})">${mark}</g>`
}

// The Mac app icon: a navy tile on the system's grid (824 of 1024, with room for its shadow).
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs>${gradient}
  <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#18235a"/><stop offset="1" stop-color="${NAVY}"/></linearGradient>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#02040f" flood-opacity="0.45"/></filter></defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#tile)" filter="url(#shadow)"/>
  <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" fill="none" stroke="#fff" stroke-opacity="0.09" stroke-width="3"/>
  ${placed(1024, 560)}</svg>`

// For a phone's home screen and the browser: the same tile, edge to edge.
const square = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024"><defs>${gradient}<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#18235a"/><stop offset="1" stop-color="${NAVY}"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#tile)"/>${placed(1024, 680)}</svg>`
const plain = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024"><defs>${gradient}</defs>${placed(1024, 960)}</svg>`

// The menu bar wants one colour with transparency: the outline of the robot, its eyes drawn in.
const eyes = MARK_FACE.replace(MARK_SCREEN, '').trim()
const tray = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024"><g transform="translate(${(1024 - 960) / 2 - 110 * (960 / 490)} ${(1024 - 505 * (960 / 490)) / 2 - 110 * (960 / 490)}) scale(${960 / 490})"><path fill="#000" fill-rule="evenodd" d="${MARK_SPARKS} ${MARK_SHELL}"/><path fill="#000" d="${eyes}"/></g></svg>`

const browser = await chromium.launch({ channel: 'chrome' })
async function render(svg, size, file) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
  await page.close()
}

mkdirSync(join(desktop, 'build'), { recursive: true })
mkdirSync(join(desktop, 'assets'), { recursive: true })
const big = join(desktop, 'build', 'icon-1024.png')
await render(appIcon, 1024, big)
const set = join(desktop, 'build', 'icon.iconset')
rmSync(set, { recursive: true, force: true })
mkdirSync(set)
for (const [name, px] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]]) {
  execFileSync('/usr/bin/sips', ['-z', String(px), String(px), big, '--out', join(set, `icon_${name}.png`)], { stdio: 'ignore' })
}
execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', join(desktop, 'build', 'icon.icns')])

await render(tray(18), 18, join(desktop, 'assets', 'trayTemplate.png'))
await render(tray(36), 36, join(desktop, 'assets', 'trayTemplate@2x.png'))

writeFileSync(join(web, 'mark.svg'), markSvg)
await render(plain(32), 32, join(web, 'icon-32.png'))
for (const size of [180, 192, 512]) await render(square(size), size, join(web, `icon-${size}.png`))
// favicon.ico: an .ico file may simply hold PNGs.
const pngs = []
for (const size of [16, 32, 48]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<body style="margin:0;background:transparent">${plain(size)}</body>`)
  pngs.push([size, await page.screenshot({ omitBackground: true })])
  await page.close()
}
const header = Buffer.alloc(6 + 16 * pngs.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(pngs.length, 4)
let offset = header.length
pngs.forEach(([size, data], i) => {
  const at = 6 + 16 * i
  header.writeUInt8(size, at)
  header.writeUInt8(size, at + 1)
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(data.length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += data.length
})
writeFileSync(join(web, 'favicon.ico'), Buffer.concat([header, ...pngs.map(([, data]) => data)]))

await browser.close()
console.log('Icons written: build/icon.icns, assets/trayTemplate*.png, and the dashboard favicons.')
