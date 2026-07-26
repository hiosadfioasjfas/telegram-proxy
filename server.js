const express = require('express')
const fetch = require('node-fetch')
const app = express()

// Extract each message BLOCK (the whole <div class="tgme_widget_message ..."> wrapper)
// so we can pull the text and its own <time datetime="..."> from the SAME block.
// This avoids the old bug where all message texts and all <time> tags on the
// page were collected into two separate flat arrays and zipped by index --
// which silently desyncs (wrong time attached to wrong message) whenever any
// message contributes zero or more than one <time> tag (forwards, service
// messages, grouped/album posts, reaction-only re-renders, etc.).
// Given html and the index right after an opening <div ...> tag's '>',
// returns the inner content up to (and the index just past) that div's
// matching closing </div>, correctly accounting for nested <div> tags.
// A plain non-greedy regex ([\s\S]*?)<\/div> instead stops at the FIRST
// </div>, silently truncating whenever the div contains nested divs
// (e.g. embedded link-preview blocks, quote blocks) -- which chopped
// explosion-warning message text off before the warning line could be
// matched.
function extractDivContent(html, contentStart) {
    let depth = 1
    let i = contentStart
    const openRegex = /<div\b/gi
    const closeTag = '</div>'
    while (i < html.length) {
        const nextOpen = html.indexOf('<div', i)
        const nextClose = html.indexOf(closeTag, i)
        if (nextClose === -1) {
            // Malformed/unclosed; just take the rest.
            return { content: html.slice(contentStart), end: html.length }
        }
        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++
            i = nextOpen + 4
        } else {
            depth--
            if (depth === 0) {
                return { content: html.slice(contentStart, nextClose), end: nextClose + closeTag.length }
            }
            i = nextClose + closeTag.length
        }
    }
    return { content: html.slice(contentStart), end: html.length }
}

function parseMessageBlocks(html) {
    const blocks = []

    // Each top-level message wrapper looks like:
    //   <div class="tgme_widget_message ..." data-post="channel/12345" ...> ... </div>
    // We find each wrapper's start, then find its matching close by brace-counting
    // div depth, since these can be deeply nested (reply previews, media, etc.)
    const wrapperRegex = /<div class="tgme_widget_message[^"]*"[^>]*data-post="[^"]*"[^>]*>/g
    let match
    const starts = []
    while ((match = wrapperRegex.exec(html)) !== null) {
        starts.push(match.index)
    }

    for (let i = 0; i < starts.length; i++) {
        const blockStart = starts[i]
        // A block runs until the next sibling wrapper starts, or end of html.
        const blockEnd = (i + 1 < starts.length) ? starts[i + 1] : html.length
        const block = html.slice(blockStart, blockEnd)

        // Text: prefer the LAST tgme_widget_message_text in the block (the
        // message's own text, not a quoted/replied-to message's text, which
        // Telegram renders earlier in the block as a preview). Use the
        // depth-aware extractor so nested divs inside the message text don't
        // truncate it.
        const textOpenRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>/g
        let openMatch
        let lastText = null
        while ((openMatch = textOpenRegex.exec(block)) !== null) {
            const { content, end } = extractDivContent(block, openMatch.index + openMatch[0].length)
            lastText = content
            textOpenRegex.lastIndex = end
        }

        if (lastText === null) continue // media-only post with no text, skip

        let text = lastText
        text = text.replace(/<tg-emoji[^>]*>[\s\S]*?<\/tg-emoji>/g, '')
                   .replace(/<br\s*\/?>/g, '\n')
                   .replace(/<[^>]+>/g, '')
                   .replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)))
                   .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
                   .replace(/\s+/g, ' ').trim()

        if (text.length === 0) continue

        // Time: prefer the LAST <time datetime="..."> in the block. Reason:
        // a reply/forward preview (rendered earlier in the block) carries the
        // ORIGINAL message's time, while the message's own posting time
        // (what we want) is the one attached to its own footer, which comes
        // last in document order within the block.
        const timeRegex = /<time[^>]*datetime="([^"]*)"/g
        let timeMatch
        let lastDatetime = null
        while ((timeMatch = timeRegex.exec(block)) !== null) {
            lastDatetime = timeMatch[1]
        }

        if (!lastDatetime) continue // couldn't find a timestamp for this block, skip

        blocks.push({ text, datetime: lastDatetime })
    }

    return blocks
}

// Formats a Date in Ukraine's local time (Europe/Kyiv).
//
// NOTE: We deliberately do NOT use Intl.DateTimeFormat with timeZone:
// 'Europe/Kyiv' here. On some minimal Node deployments (e.g. Render's
// default build), Node ships with the "small-icu" data set, which only
// has full timezone data for en-US and silently falls back to an
// incorrect zone for everything else -- producing wrong, non-round-hour
// offsets instead of throwing an error. To avoid depending on the host's
// ICU data at all, we compute the EET/EEST offset manually here.
//
// Ukraine currently still observes the DST switch (the 2024 law to
// abolish it was never implemented): EEST (UTC+3) in summer, EET (UTC+2)
// in winter. EU-style DST rules apply: starts last Sunday of March at
// 01:00 UTC, ends last Sunday of October at 01:00 UTC.
function isUkraineDST(date) {
    const year = date.getUTCFullYear()

    // Last Sunday of March, 01:00 UTC
    const marchLastDay = new Date(Date.UTC(year, 2, 31))
    const marchLastSunday = new Date(Date.UTC(year, 2, 31 - marchLastDay.getUTCDay()))
    const dstStart = new Date(Date.UTC(year, 2, marchLastSunday.getUTCDate(), 1, 0, 0))

    // Last Sunday of October, 01:00 UTC
    const octLastDay = new Date(Date.UTC(year, 9, 31))
    const octLastSunday = new Date(Date.UTC(year, 9, 31 - octLastDay.getUTCDay()))
    const dstEnd = new Date(Date.UTC(year, 9, octLastSunday.getUTCDate(), 1, 0, 0))

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

    return `${dd}/${mo} ${hh}:${mi} KYIV`
}

// Google Translate's public "gtx" client endpoint (same one used by browser
// extensions / gtranslate). Free, no API key, and noticeably better quality
// than MyMemory / LibreTranslate for this kind of text.
async function translateText(text, targetLang) {
    if (!text || !text.trim()) return text
    // Google's endpoint has a practical URL length limit, so split long
    // messages into chunks on sentence/newline boundaries and translate
    // each chunk, then rejoin. This avoids truncation on long alerts.
    const MAX_CHUNK = 1800
    const chunks = []
    let remaining = text
    while (remaining.length > MAX_CHUNK) {
        // try to break on the last newline or period before the limit
        let splitAt = remaining.lastIndexOf('\n', MAX_CHUNK)
        if (splitAt < MAX_CHUNK * 0.5) splitAt = remaining.lastIndexOf('. ', MAX_CHUNK)
        if (splitAt < MAX_CHUNK * 0.5) splitAt = MAX_CHUNK
        chunks.push(remaining.slice(0, splitAt + 1))
        remaining = remaining.slice(splitAt + 1)
    }
    chunks.push(remaining)

    const translatedChunks = []
    for (const chunk of chunks) {
        const url = 'https://translate.googleapis.com/translate_a/single'
            + '?client=gtx&sl=auto&tl=' + encodeURIComponent(targetLang)
            + '&dt=t&q=' + encodeURIComponent(chunk)
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        if (!r.ok) throw new Error('Translate request failed: ' + r.status)
        const data = await r.json()
        // data[0] is an array of [translatedPart, originalPart, ...] segments
        const translated = (data[0] || []).map(seg => seg[0]).join('')
        translatedChunks.push(translated)
    }
    return translatedChunks.join('')
}

async function translateAll(messages, targetLang) {
    // Translate in parallel but capped, to be a good citizen of the free endpoint
    const CONCURRENCY = 5
    const results = new Array(messages.length)
    let idx = 0
    async function worker() {
        while (idx < messages.length) {
            const i = idx++
            try {
                results[i] = await translateText(messages[i], targetLang)
            } catch (e) {
                results[i] = messages[i] // fall back to original text on failure
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, messages.length) }, worker))
    return results
}

app.get('/fetch', async (req, res) => {
    // This endpoint reflects a live, frequently-updating feed -- explicitly
    // disable caching so no intermediate layer (Render's edge, a browser,
    // a proxy in between) ever serves a stale snapshot instead of hitting
    // Telegram fresh on every request.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')

    try {
        const url = req.query.url
        if (!url || !url.startsWith('https://t.me/')) return res.status(403).send('Forbidden')
        const lg = req.query.lg // e.g. "en" -- if absent, no translation (default behavior)

        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        const html = await r.text()

        let blocks = parseMessageBlocks(html).slice(-10)
        let messages = blocks.map(b => b.text)
        const times = blocks.map(b => formatKyivTime(new Date(b.datetime)))

        if (lg) {
            try {
                messages = await translateAll(messages, lg)
            } catch (e) {
                // if translation fails entirely, just fall back to originals silently
            }
        }

        const result = messages.map((text, i) => ({
            text,
            time: times[i] || ''
        }))
        res.json(result)
    } catch(e) {
        res.status(500).send('Error: ' + e.message)
    }
})

app.listen(process.env.PORT || 3000, () => console.log('Proxy running'))
