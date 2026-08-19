import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SETTINGS_DIR = path.join(ROOT, 'src/renderer/src/components/settings')
const LOCALES_DIR = path.join(ROOT, 'src/renderer/src/locales')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const KEY_RE = /\bt\(\s*'([a-zA-Z0-9_.]+)'/g
const META_RE = /\b(?:labelKey|descKey|contextKey)\s*:\s*'([a-zA-Z0-9_.]+)'/g

const enPath = path.join(LOCALES_DIR, 'en/settings.json')
const en = JSON.parse(fs.readFileSync(enPath, 'utf8'))
const enTopLevel = new Set(Object.keys(en))

// Files whose `useTranslation` default namespace is not `settings` pull keys
// from other bundles; only audit files that actually bind the settings bundle.
const keys = new Set()
for (const file of walk(SETTINGS_DIR)) {
  const src = fs.readFileSync(file, 'utf8')
  const bindsSettings =
    src.includes("useTranslation('settings')") || file.endsWith('settings-nav.ts')
  if (!bindsSettings) continue
  const otherNs = /useTranslation\('(?!settings')[a-z]+'\)/.test(src)
  for (const m of src.matchAll(KEY_RE)) keys.add(m[1])
  for (const m of src.matchAll(META_RE)) keys.add(m[1])
  if (otherNs) {
    // Mixed-namespace file: keep only keys whose root exists in settings.json
    // or which we know are new settings keys.
  }
}

function get(obj, key) {
  return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj)
}

const NEW_PREFIXES = ['page.', 'runtime.', 'data.', 'model.sections.', 'general.sections.']
const candidates = [...keys].filter(
  (k) => enTopLevel.has(k.split('.')[0]) || NEW_PREFIXES.some((p) => k.startsWith(p))
)

const locales = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

const report = {}
for (const locale of locales) {
  const file = path.join(LOCALES_DIR, locale, 'settings.json')
  if (!fs.existsSync(file)) continue
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  report[locale] = candidates.filter((k) => typeof get(json, k) !== 'string').sort()
}

console.log(`candidate settings keys: ${candidates.length}`)
console.log(`\n=== missing in en (${report.en.length}) ===`)
for (const k of report.en) console.log('  ' + k)
console.log('\n=== counts ===')
for (const [locale, missing] of Object.entries(report)) console.log(`  ${locale}: ${missing.length}`)
fs.writeFileSync(path.join(ROOT, 'scripts/.i18n-report.json'), JSON.stringify(report, null, 2))
