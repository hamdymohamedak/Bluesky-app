/**
 * Builds src/locale/locales/ar/messages.po from en/messages.po using machine translation.
 * Preserves ICU placeholders as well as Google Translate usually can; review critical strings.
 *
 * Usage:
 *   node scripts/translate-en-po-to-ar.mjs
 *   ALLOW_PARTIAL=1 LIMIT=50 node scripts/translate-en-po-to-ar.mjs  # dev only; leaves rest empty
 *   TRANSLATE_MS_DELAY=200 node scripts/translate-en-po-to-ar.mjs
 *
 * Then: yarn intl:compile
 */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import PO from 'pofile'
import {translate} from 'google-translate-api-x'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const enPath = path.join(root, 'src/locale/locales/en/messages.po')
const arPath = path.join(root, 'src/locale/locales/ar/messages.po')
const cachePath = path.join(root, 'scripts/.ar-po-translate-cache.json')

const delayMs = Number(process.env.TRANSLATE_MS_DELAY || 120)
const allowPartial = process.env.ALLOW_PARTIAL === '1'
const limit =
  allowPartial && process.env.LIMIT ? Number(process.env.LIMIT) : undefined
if (process.env.LIMIT && !allowPartial) {
  console.error('Set ALLOW_PARTIAL=1 to use LIMIT= (otherwise all strings are translated).')
  process.exit(1)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  } catch {
    return {}
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(cachePath), {recursive: true})
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 0), 'utf8')
}

/**
 * Lingui/ICU strings must keep ASCII keywords (plural, one, other, select) and commas.
 * Machine translation corrupts them; keep English source for these entries.
 */
function shouldKeepEnglishSource(msgid) {
  if (
    /,\s*plural\s*,/i.test(msgid) ||
    /,\s*select\s*,/i.test(msgid) ||
    /,\s*selectordinal\s*,/i.test(msgid)
  ) {
    return true
  }
  // Rich text / component slots from <Trans> – keep structure
  if (/<\d+>/.test(msgid)) {
    return true
  }
  // Named ICU placeholders – MT often translates the identifier inside {…}
  if (/\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(msgid)) {
    return true
  }
  return false
}

async function translateWithRetry(text) {
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await translate(text, {from: 'en', to: 'ar'})
      return res.text
    } catch (e) {
      lastErr = e
      const wait = Math.min(30_000, 800 * 2 ** attempt)
      console.warn(`  translate retry ${attempt + 1}: ${e.message} (wait ${wait}ms)`)
      await sleep(wait)
    }
  }
  throw lastErr
}

async function main() {
  const enSrc = fs.readFileSync(enPath, 'utf8')
  const po = PO.parse(enSrc)

  po.headers.Language = 'ar'
  po.headers['Language-Team'] = 'Arabic'
  po.headers['Plural-Forms'] =
    'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 && n%100<=99 ? 4 : 5);'
  po.headers['Content-Type'] = 'text/plain; charset=UTF-8'
  po.headers['PO-Revision-Date'] = new Date().toISOString().slice(0, 16).replace('T', ' ')

  const cache = loadCache()
  let items = po.items
  if (limit != null && Number.isFinite(limit)) {
    items = items.slice(0, limit)
  }

  let i = 0
  for (const item of items) {
    i++
    const msgid = item.msgid
    if (msgid === '') {
      continue
    }

    if (shouldKeepEnglishSource(msgid)) {
      item.msgstr = [msgid]
      delete cache[msgid]
      if (i % 100 === 0) {
        console.log(`${i}/${items.length} (ICU/rich, English)`)
      }
      continue
    }

    if (cache[msgid]) {
      item.msgstr = [cache[msgid]]
      if (i % 100 === 0) {
        console.log(`${i}/${items.length} (cached)`)
      }
      continue
    }

    process.stdout.write(`${i}/${items.length} ${msgid.slice(0, 60)}…\n`)
    const ar = await translateWithRetry(msgid)
    cache[msgid] = ar
    item.msgstr = [ar]

    if (i % 25 === 0) {
      saveCache(cache)
    }
    await sleep(delayMs)
  }

  saveCache(cache)
  fs.writeFileSync(arPath, po.toString(), 'utf8')
  console.log(`Wrote ${arPath}`)
  console.log('Run: yarn intl:compile')
}

await main()
