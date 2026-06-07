const express = require('express')
const fetch = require('node-fetch')
const app = express()

// Pre-translation glossary: Ukrainian/Russian military terms → English
const GLOSSARY = {
    'КАБ': 'KAB (guided aerial bomb)',
    'КАБи': 'KABs (guided aerial bombs)',
    'КАБів': 'KABs (guided aerial bombs)',
    'БПЛА': 'UAV (drone)',
    'БпЛА': 'UAV (drone)',
    'ППО': 'air defense (PVO)',
    'ЗРК': 'SAM system',
    'РСЗО': 'MLRS',
    'МіГ': 'MiG',
    'Су-': 'Su-',
    'Іл-': 'Il-',
    'Ту-': 'Tu-',
    'ЗСУ': 'Armed Forces of Ukraine (ZSU)',
    'ЗРК': 'air defense missile system',
    'С-300': 'S-300',
    'С-400': 'S-400',
    'Шахед': 'Shahed drone',
    'Шахеди': 'Shahed drones',
    'Шахедів': 'Shahed drones',
    'Кинджал': 'Kinzhal missile',
    'Калібр': 'Kalibr missile',
    'Калібри': 'Kalibr missiles',
    'Іскандер': 'Iskander missile',
    'Герань': 'Geran drone',
    'Герані': 'Geran drones',
    'ФАБ': 'FAB (free-fall bomb)',
    'ФАБи': 'FABs (free-fall bombs)',
    'ГРУ': 'GRU (Russian military intelligence)',
    'ФСБ': 'FSB (Russian security service)',
    'тис.': 'thousand',
    'млн.': 'million',
    'обл.': 'oblast',
    'р-н': 'district',
    'м.': 'city',
    'смт.': 'urban-type settlement',
}

function applyGlossary(text) {
    let result = text
    for (const [uk, en] of Object.entries(GLOSSARY)) {
        // Word-boundary safe replace
        result = result.replace(new RegExp(`(?<![а-яА-ЯёЁіІїЇєЄ])${uk}(?![а-яА-ЯёЁіІїЇєЄ])`, 'g'), en)
    }
    return result
}

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

async function translate(text) {
    if (!text || text.trim().length === 0) return text
    try {
        // Apply glossary BEFORE translating so Google doesn't mangle known terms
        const glossarized = applyGlossary(text)
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(glossarized)}`
        const r = await fetch(url)
        const data = await r.json()
        if (data && data[0]) {
            return data[0].map(chunk => chunk[0]).filter(Boolean).join('')
        }
    } catch(e) {
        console.error('Translation error:', e.message)
    }
    return text
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

        const translated = await Promise.all(messages.map(async (text, i) => ({
            text: await translate(text),
            time: times[i] || ''
        })))

        res.json(translated)
    } catch(e) {
        res.status(500).send('Error: ' + e.message)
    }
})

app.listen(process.env.PORT || 3000, () => console.log('Proxy running'))
