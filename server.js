const express = require('express')
const fetch = require('node-fetch')
const app = express()

// Supported translation languages, as accepted by THIS proxy's ?lg= param
// (kept the same as before so the Roblox side doesn't need to change).
// zh-CN maps to LibreTranslate's "zh" code internally (see LT_LANG_MAP).
const SUPPORTED_LANGUAGES = new Set([
    'en',
    'ru',
    'tl',
    'zh-CN'
])

// Maps our public ?lg= values to the language codes LibreTranslate expects.
const LT_LANG_MAP = {
    'en': 'en',
    'ru': 'ru',
    'tl': 'tl',
    'zh-CN': 'zh'
}

// Self-hosted LibreTranslate instance (Render service). Set this via the
// LIBRETRANSLATE_URL environment variable on Render so it's not hardcoded;
// falls back to localhost for local dev/testing.
const LIBRETRANSLATE_URL =
    process.env.LIBRETRANSLATE_URL || 'http://localhost:5000'

// Extract each message BLOCK (the whole <div class="tgme_widget_message ..."> wrapper)
// so we can pull the text and its own <time datetime="..."> from the SAME block.
function extractDivContent(html, contentStart) {
    let depth = 1
    let i = contentStart
    const closeTag = '</div>'

    while (i < html.length) {
        const nextOpen = html.indexOf('<div', i)
        const nextClose = html.indexOf(closeTag, i)

        if (nextClose === -1) {
            return {
                content: html.slice(contentStart),
                end: html.length
            }
        }

        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++
            i = nextOpen + 4
        } else {
            depth--

            if (depth === 0) {
                return {
                    content: html.slice(contentStart, nextClose),
                    end: nextClose + closeTag.length
                }
            }

            i = nextClose + closeTag.length
        }
    }

    return {
        content: html.slice(contentStart),
        end: html.length
    }
}

function parseMessageBlocks(html) {
    const blocks = []

    const wrapperRegex =
        /<div class="tgme_widget_message[^"]*"[^>]*data-post="[^"]*"[^>]*>/g

    let match
    const starts = []

    while ((match = wrapperRegex.exec(html)) !== null) {
        starts.push(match.index)
    }

    for (let i = 0; i < starts.length; i++) {
        const blockStart = starts[i]
        const blockEnd =
            (i + 1 < starts.length)
                ? starts[i + 1]
                : html.length

        const block = html.slice(blockStart, blockEnd)

        // Prefer the LAST message text block.
        const textOpenRegex =
            /<div class="tgme_widget_message_text[^"]*"[^>]*>/g

        let openMatch
        let lastText = null

        while ((openMatch = textOpenRegex.exec(block)) !== null) {
            const { content, end } = extractDivContent(
                block,
                openMatch.index + openMatch[0].length
            )

            lastText = content
            textOpenRegex.lastIndex = end
        }

        if (lastText === null) continue

        let text = lastText

        text = text
            .replace(/<tg-emoji[^>]*>[\s\S]*?<\/tg-emoji>/g, '')
            .replace(/<br\s*\/?>/g, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#(\d+);/g, (_, c) =>
                String.fromCharCode(parseInt(c))
            )
            .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
                String.fromCharCode(parseInt(h, 16))
            )
            .replace(/\s+/g, ' ')
            .trim()

        if (text.length === 0) continue

        // Prefer the LAST timestamp in the block.
        const timeRegex =
            /<time[^>]*datetime="([^"]*)"/g

        let timeMatch
        let lastDatetime = null

        while ((timeMatch = timeRegex.exec(block)) !== null) {
            lastDatetime = timeMatch[1]
        }

        if (!lastDatetime) continue

        blocks.push({
            text,
            datetime: lastDatetime
        })
    }

    return blocks
}

// Ukraine / Kyiv local time.
function isUkraineDST(date) {
    const year = date.getUTCFullYear()

    // Last Sunday of March, 01:00 UTC
    const marchLastDay = new Date(Date.UTC(year, 2, 31))
    const marchLastSunday = new Date(
        Date.UTC(
            year,
            2,
            31 - marchLastDay.getUTCDay()
        )
    )

    const dstStart = new Date(
        Date.UTC(
            year,
            2,
            marchLastSunday.getUTCDate(),
            1,
            0,
            0
        )
    )

    // Last Sunday of October, 01:00 UTC
    const octLastDay = new Date(Date.UTC(year, 9, 31))
    const octLastSunday = new Date(
        Date.UTC(
            year,
            9,
            31 - octLastDay.getUTCDay()
        )
    )

    const dstEnd = new Date(
        Date.UTC(
            year,
            9,
            octLastSunday.getUTCDate(),
            1,
            0,
            0
        )
    )

    return date >= dstStart && date < dstEnd
}

function formatKyivTime(date) {
    const offsetHours = isUkraineDST(date) ? 3 : 2
    const kyivMs = date.getTime() + offsetHours * 60 * 60 * 1000
    const kyiv = new Date(kyivMs)

    const dd = String(kyiv.getUTCDate()).padStart(2, '0')
    const mo = String(kyiv.getUTCMonth() + 1).padStart(2, '0')
    const hh = String(kyiv.getUTCHours()).padStart(2, '0')
    const mi = String(kyiv.getUTCMinutes()).padStart(2, '0')

    return dd + '/' + mo + ' ' + hh + ':' + mi + ' KYIV'
}

// ------------------------------------------------------------------
// Small in-memory translation cache.
//
// Keyed by "<targetLang>::<original text>". This means:
//   - identical messages (very common with alert-bot channels) are only
//     ever translated once per language, not on every single poll
//   - re-fetches after a language switch don't re-translate messages
//     that were already translated recently
// This substantially cuts down how often we hit Google's endpoint,
// which reduces the chance of getting rate-limited/blocked again.
// ------------------------------------------------------------------
const TRANSLATION_CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const translationCache = new Map() // key -> { text, expiresAt }

function getCached(key) {
    const entry = translationCache.get(key)
    if (!entry) return null

    if (Date.now() > entry.expiresAt) {
        translationCache.delete(key)
        return null
    }

    return entry.text
}

function setCached(key, text) {
    translationCache.set(key, {
        text,
        expiresAt: Date.now() + TRANSLATION_CACHE_TTL_MS
    })
}

// Periodically sweep expired entries so the map doesn't grow forever.
setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of translationCache) {
        if (now > entry.expiresAt) {
            translationCache.delete(key)
        }
    }
}, 10 * 60 * 1000)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Self-hosted LibreTranslate instance.
// Retries on transient failures (503 = model still loading/cold start,
// or general upstream trouble) with backoff, and logs the actual failure
// reason instead of failing silently.
async function translateChunk(chunk, targetLang, attempt = 1) {
    const MAX_ATTEMPTS = 3
    const ltTargetLang = LT_LANG_MAP[targetLang] || targetLang

    let r
    try {
        r = await fetch(LIBRETRANSLATE_URL + '/translate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: chunk,
                source: 'auto',
                target: ltTargetLang,
                format: 'text'
            }),
            // LibreTranslate can be slow on a small/free instance,
            // especially right after a cold start. Give it real time
            // before giving up. AbortSignal.timeout works regardless of
            // node-fetch major version (v2's 'timeout' option was removed
            // in v3, so this is the portable way to do it).
            signal: AbortSignal.timeout(20000)
        })
    } catch (networkErr) {
        console.error(
            '[translate] network error (attempt ' + attempt + '/' + MAX_ATTEMPTS + '):',
            networkErr.message
        )

        if (attempt < MAX_ATTEMPTS) {
            await sleep(500 * attempt)
            return translateChunk(chunk, targetLang, attempt + 1)
        }

        throw networkErr
    }

    if (!r.ok) {
        const bodyText = await r.text().catch(() => '<no body>')

        console.error(
            '[translate] request failed (attempt ' + attempt + '/' + MAX_ATTEMPTS + '): ' +
            'status=' + r.status + ' target=' + ltTargetLang + ' body=' +
            bodyText.slice(0, 300)
        )

        // 503 commonly means LibreTranslate is still loading models
        // (cold start) or is overloaded on a small instance. Worth a retry.
        const isRetryable = r.status === 503 || r.status === 429 || r.status >= 500

        if (isRetryable && attempt < MAX_ATTEMPTS) {
            await sleep(1500 * attempt) // longer backoff: model loading can take a while
            return translateChunk(chunk, targetLang, attempt + 1)
        }

        throw new Error('Translate request failed: ' + r.status)
    }

    const data = await r.json()

    if (typeof data.translatedText !== 'string') {
        console.error(
            '[translate] unexpected response shape:',
            JSON.stringify(data).slice(0, 300)
        )
        throw new Error('Unexpected LibreTranslate response shape')
    }

    return data.translatedText
}

async function translateText(text, targetLang) {
    if (!text || !text.trim()) return text

    const cacheKey = targetLang + '::' + text
    const cached = getCached(cacheKey)
    if (cached !== null) {
        return cached
    }

    const MAX_CHUNK = 1800
    const chunks = []

    let remaining = text

    while (remaining.length > MAX_CHUNK) {
        let splitAt =
            remaining.lastIndexOf('\n', MAX_CHUNK)

        if (splitAt < MAX_CHUNK * 0.5) {
            splitAt =
                remaining.lastIndexOf('. ', MAX_CHUNK)
        }

        if (splitAt < MAX_CHUNK * 0.5) {
            splitAt = MAX_CHUNK
        }

        chunks.push(
            remaining.slice(0, splitAt + 1)
        )

        remaining =
            remaining.slice(splitAt + 1)
    }

    chunks.push(remaining)

    const translatedChunks = []

    for (const chunk of chunks) {
        const translated = await translateChunk(chunk, targetLang)
        translatedChunks.push(translated)
    }

    const result = translatedChunks.join('')

    setCached(cacheKey, result)

    return result
}

async function translateAll(messages, targetLang) {
    const CONCURRENCY = 3 // lowered from 5 to be gentler on the upstream endpoint

    const results =
        new Array(messages.length)

    let idx = 0
    let failureCount = 0

    async function worker() {
        while (idx < messages.length) {
            const i = idx++

            try {
                results[i] =
                    await translateText(
                        messages[i],
                        targetLang
                    )
            } catch (e) {
                // If translation fails after retries, fall back to the
                // original text for THIS message only, but log it loudly
                // so it's visible in Render logs instead of silently
                // vanishing.
                failureCount++
                console.error(
                    '[translate] giving up on message ' + i + ' (' + targetLang + '):',
                    e.message
                )
                results[i] = messages[i]
            }
        }
    }

    await Promise.all(
        Array.from(
            {
                length: Math.min(
                    CONCURRENCY,
                    messages.length
                )
            },
            worker
        )
    )

    if (failureCount > 0) {
        console.error(
            '[translate] ' + failureCount + '/' + messages.length +
            ' message(s) failed to translate into "' + targetLang +
            '" and were served untranslated.'
        )
    }

    return results
}

app.get('/fetch', async (req, res) => {
    // Disable caching so Telegram is fetched fresh.
    res.set(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
    )

    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')

    try {
        const url = req.query.url

        if (
            !url ||
            !url.startsWith('https://t.me/')
        ) {
            return res.status(403).send('Forbidden')
        }

        // Language parameter:
        //
        // ?lg=en     -> English
        // ?lg=ru     -> Russian
        // ?lg=tl     -> Filipino
        // ?lg=zh-CN  -> Mandarin Chinese
        //
        // If omitted, original Telegram text is returned.
        const lg = req.query.lg // e.g. "en" -- if absent, no translation (default behavior)

        if (lg && !SUPPORTED_LANGUAGES.has(lg)) {
            return res.status(400).json({
                error: 'Unsupported language',
                supportedLanguages: Array.from(SUPPORTED_LANGUAGES)
            })
        }

        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        })

        const html = await r.text()

        let blocks =
            parseMessageBlocks(html).slice(-10)

        let messages =
            blocks.map(b => b.text)

        const times =
            blocks.map(b =>
                formatKyivTime(
                    new Date(b.datetime)
                )
            )

        // Translate if a language was requested.
        if (lg) {
            try {
                messages =
                    await translateAll(
                        messages,
                        lg
                    )
            } catch (e) {
                // This should be rare now since translateAll handles
                // per-message failures internally, but log it just in case
                // something else throws (e.g. a bug in translateAll itself).
                console.error(
                    '[translate] translateAll threw unexpectedly for "' + lg + '":',
                    e.message
                )
            }
        }

        const result =
            messages.map((text, i) => ({
                text,
                time: times[i] || ''
            }))

        res.json(result)

    } catch (e) {
        console.error('[fetch] handler error:', e.message)
        res.status(500).send(
            'Error: ' + e.message
        )
    }
})

app.listen(
    process.env.PORT || 3000,
    () => console.log('Proxy running')
)

// ------------------------------------------------------------------
// Keep-alive ping for the LibreTranslate service.
//
// Render's free tier spins down services after ~15 min of no HTTP
// traffic. If LibreTranslate spins down between Roblox polls, the next
// real translation request eats a slow cold-start (and may even time
// out/503 once, before translateChunk's retry logic kicks in and
// succeeds on attempt 2/3). Pinging it periodically keeps it warm.
//
// This does NOT prevent THIS proxy itself from spinning down if Render
// still doesn't see external traffic to it directly, but Roblox's own
// ~10s polling already keeps this proxy warm; this ping just extends
// that courtesy to the LibreTranslate service it depends on.
// ------------------------------------------------------------------
setInterval(() => {
    fetch(LIBRETRANSLATE_URL + '/languages').catch(() => {
        // Ignore failures here; translateChunk's own retry logic handles
        // real translation requests failing. This is just a keep-alive.
    })
}, 5 * 60 * 1000) // every 5 minutes
