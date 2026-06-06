const express = require('express')
const fetch = require('node-fetch')
const app = express()

function parseMessages(html) {
    const messages = []
    const regex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g
    let match
    while ((match = regex.exec(html)) !== null) {
        let text = match[1]
        // Strip custom emoji tags entirely (they cause the &#33; garbage)
        text = text.replace(/<tg-emoji[^>]*>[\s\S]*?<\/tg-emoji>/g, '')
        // Replace <br> with newline
        text = text.replace(/<br\s*\/?>/g, '\n')
        // Strip remaining HTML tags
        text = text.replace(/<[^>]+>/g, '')
        // Decode HTML entities
        text = text.replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)))
                   .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        text = text.replace(/\s+/g, ' ').trim()
        if (text.length > 0) messages.push(text)
    }
    return messages
}

async function translate(text) {
    if (!text || text.trim().length === 0) return text
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`
        const r = await fetch(url)
        const data = await r.json()
        if (data && data[0]) {
            return data[0].map(chunk => chunk[0]).filter(Boolean).join('')
        }
    } catch(e) {
        console.error('Translation error:', e.message)
    }
    return text // fallback to original if translation fails
}

app.get('/fetch', async (req, res) => {
    try {
        const url = req.query.url
        if (!url || !url.startsWith('https://t.me/')) return res.status(403).send('Forbidden')
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        const html = await r.text()
        const messages = parseMessages(html).slice(-10) // last 10
        const translated = await Promise.all(messages.map(m => translate(m)))
        res.json(translated)
    } catch(e) {
        res.status(500).send('Error: ' + e.message)
    }
})

app.listen(process.env.PORT || 3000, () => console.log('Proxy running'))
