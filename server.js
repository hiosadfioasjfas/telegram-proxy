const express = require('express')
const fetch = require('node-fetch')
const app = express()

app.get('/fetch', async (req, res) => {
  try {
    const url = req.query.url
    if (!url || !url.startsWith('https://t.me/')) return res.status(403).send('Forbidden')
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    res.send(await r.text())
  } catch(e) {
    res.status(500).send('Error: ' + e.message)
  }
})

app.listen(process.env.PORT || 3000, () => console.log('Proxy running'))
