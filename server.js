const express = require('express')
const fetch = require('node-fetch')
const app = express()

function parseMessages(html) {
    const messages = []
    const regex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g
    let match
    while ((match = regex.exec(html)) !== null) {
        let text = match[1]
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
        if (text.length > 0) messages.push(text)
    }
    return messages
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
    try {
        const url = req.query.url
        if (!url || !url.startsWith('https://t.me/')) return res.status(403).send('Forbidden')
        const lg = req.query.lg // e.g. "en" -- if absent, no translation (default behavior)

        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        const html = await r.text()
        let messages = parseMessages(html).slice(-10)

        const timeRegex = /<time[^>]*datetime="([^"]*)"/g
        const times = []
        let tm
        while ((tm = timeRegex.exec(html)) !== null) {
            const date = new Date(tm[1])
            times.push(formatKyivTime(date))
        }

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
