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

app.get('/fetch', async (req, res) => {
    try {
        const url = req.query.url
        if (!url || !url.startsWith('https://t.me/')) return res.status(403).send('Forbidden')
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        const html = await r.text()
        const messages = parseMessages(html).slice(-10)

        const timeRegex = /<time[^>]*datetime="([^"]*)"/g
        const times = []
        let tm
        while ((tm = timeRegex.exec(html)) !== null) {
            const date = new Date(tm[1])
            const hh = String(date.getUTCHours()).padStart(2, '0')
            const mm = String(date.getUTCMinutes()).padStart(2, '0')
            const dd = String(date.getUTCDate()).padStart(2, '0')
            const mo = String(date.getUTCMonth() + 1).padStart(2, '0')
            times.push(`${dd}/${mo} ${hh}:${mm} UTC`)
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
