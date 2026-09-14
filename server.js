```js
const express = require('express')
const fetch = require('node-fetch')
const app = express()

// Supported translation languages.
// Google Translate language codes:
// en     = English
// ru     = Russian
// tl     = Filipino (Tagalog)
// zh-CN  = Mandarin Chinese (Simplified)
const SUPPORTED_LANGUAGES = new Set([
    'en',
    'ru',
    'tl',
    'zh-CN'
])

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

    const kyivMs =
        date.getTime() +
        offsetHours * 60 * 60 * 1000

    const kyiv = new Date(kyivMs)

    const dd = String(kyiv.getUTCDate()).padStart(2, '0')
    const mo = String(kyiv.getUTCMonth() + 1).padStart(2, '0')
    const hh = String(kyiv.getUTCHours()).padStart(2, '0')
    const mi = String(kyiv.getUTCMinutes()).padStart(2, '0')

    return `${dd}/${mo} ${hh}:${mi} KYIV`
}

// Google Translate public GTX endpoint.
async function translateText(text, targetLang) {
    if (!text || !text.trim()) return text

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
        const url =
            'https://translate.googleapis.com/translate_a/single' +
            '?client=gtx' +
            '&sl=auto' +
            '&tl=' + encodeURIComponent(targetLang) +
            '&dt=t' +
            '&q=' + encodeURIComponent(chunk)

        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        })

        if (!r.ok) {
            throw new Error(
                'Translate request failed: ' + r.status
            )
        }

        const data = await r.json()

        const translated =
            (data[0] || [])
                .map(seg => seg[0])
                .join('')

        translatedChunks.push(translated)
    }

    return translatedChunks.join('')
}

async function translateAll(messages, targetLang) {
    const CONCURRENCY = 5

    const results =
        new Array(messages.length)

    let idx = 0

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
                // If translation fails, use original text.
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
        const lg = req.query.lg

        // Only allow the languages we explicitly support.
        if (lg && !SUPPORTED_LANGUAGES.has(lg)) {
            return res.status(400).json({
                error: 'Unsupported language',
                supportedLanguages: [
                    'en',
                    'ru',
                    'tl',
                    'zh-CN'
                ]
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
                // Translation failure:
                // silently keep original messages.
            }
        }

        const result =
            messages.map((text, i) => ({
                text,
                time: times[i] || ''
            }))

        res.json(result)

    } catch (e) {
        res.status(500).send(
            'Error: ' + e.message
        )
    }
})

app.listen(
    process.env.PORT || 3000,
    () => console.log('Proxy running')
)
```
