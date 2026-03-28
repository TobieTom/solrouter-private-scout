require('dotenv').config()

function formatVolume(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'
  return n.toFixed(2)
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const query = req.body?.query
    ?.toString()
    .trim()
    .slice(0, 100)

  if (!query) {
    return res.status(400).json({
      error: true,
      message: 'Query required'
    })
  }

  const API_KEY = process.env.SOLROUTER_API_KEY
  const AGENT_URL = 'https://api.solrouter.com/agent'

  try {
    const response = await fetch(AGENT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: `You are a Solana token analyst.
Analyze this token: ${query}

Execute these steps in order:
1. Use web_search to find current price and 24h volume from CoinGecko or CoinMarketCap.
   Search: "${query} price USD coinmarketcap"
2. Use token_price tool for liquidity data only
3. Use swap_quote for best swap route

Return ONLY this JSON, no markdown:
{
  "tokenName": string,
  "ticker": string,
  "price": string (e.g. "$0.1532"),
  "priceChange24h": string (e.g. "+0.39%"),
  "liquidityScore": number (0-100),
  "volume24h": string (e.g. "$26.01M"),
  "swapQuote": string,
  "swapRoute": string,
  "riskSignal": "BULLISH" | "BEARISH" | "NEUTRAL",
  "analysis": string (3 sentences max)
}`,
        model: 'gpt-oss:20b',
        useTools: true
      })
    })

    console.log('Status:', response.status)
    const rawText = await response.text()
    console.log('Raw response:', rawText)

    const data = JSON.parse(rawText)
    const reply = data.reply
    console.log('Reply field:', reply)

    // Try parsing reply as JSON first
    let result
    try {
      result = JSON.parse(data.reply)
    } catch(e) {
      // reply is not valid JSON — extract from toolCalls
      result = {
        tokenName: 'Unknown',
        ticker: query.toUpperCase(),
        price: 'N/A',
        priceChange24h: 'N/A',
        liquidityScore: 0,
        volume24h: 'N/A',
        swapQuote: 'Unavailable',
        swapRoute: '',
        riskSignal: 'NEUTRAL',
        analysis: 'Analysis unavailable.',
        toolsUsed: []
      }

      if (data.toolCalls && Array.isArray(data.toolCalls)) {

        // STEP 1 — web_search first: price, volume, priceChange
        for (const call of data.toolCalls) {
          if (call.tool !== 'web_search') continue
          if (!call.result || !call.result.results) continue
          const results = call.result.results

          for (const r of results) {
            const text = r.content || r.snippet || r.description || ''

            // Price
            if (result.price === 'N/A') {
              const priceMatch = text.match(
                /\$([0-9,]+(?:\.[0-9]{1,8})?)\s*(?:USD)?/
              )
              if (priceMatch) {
                const raw = priceMatch[1].replace(/,/g, '')
                result.price = '$' + parseFloat(raw).toLocaleString()
              }
            }

            // Volume
            if (result.volume24h === 'N/A') {
              const volMatch = text.match(
                /(?:volume|vol)[^\$]*\$([0-9,.]+\s*[BMKbmk]?)/i
              )
              if (volMatch) {
                let vol = volMatch[1].trim().replace(/,/g, '')
                const num = parseFloat(vol)
                const suffix = vol.match(/[BMK]$/i)?.[0] || ''
                if (!isNaN(num)) {
                  let finalNum = num
                  if (suffix.toUpperCase() === 'B') finalNum = num * 1e9
                  else if (suffix.toUpperCase() === 'M') finalNum = num * 1e6
                  else if (suffix.toUpperCase() === 'K') finalNum = num * 1e3
                  result.volume24h = '$' + formatVolume(finalNum)
                }
              }
            }

            // Price change
            if (result.priceChange24h === 'N/A') {
              const changeMatch = text.match(
                /([+-]?[0-9]+(?:\.[0-9]+)?%)|([0-9]+(?:\.[0-9]+)?%)\s*(?:up|down|change|24h|today|\(24h\))/i
              ) || text.match(
                /(?:up|down)\s+([0-9]+(?:\.[0-9]+)?%)/i
              )
              if (changeMatch) {
                let val = changeMatch[1] || changeMatch[2] ||
                          changeMatch[3]
                if (val) {
                  const isDown = /down/i.test(text.substring(
                    Math.max(0, text.indexOf(val) - 20),
                    text.indexOf(val)
                  ))
                  const n = parseFloat(val.replace('%', ''))
                  if (!isNaN(n)) {
                    result.priceChange24h = (isDown ? '-' : '+') +
                      n.toFixed(2) + '%'
                  }
                }
              }
            }
          }
        }

        // STEP 2 — token_price: liquidity + name/ticker only
        for (const call of data.toolCalls) {
          if (call.tool !== 'token_price') continue
          const r = call.result
          if (!r) continue
          if (r.liquidity !== undefined)
            result.liquidityScore = Math.min(100,
              Math.round((r.liquidity / 1000000) * 10))
          if (result.tokenName === 'Unknown')
            result.tokenName = r.name || query
          if (result.ticker === query.toUpperCase())
            result.ticker = (r.ticker || r.symbol || query).toUpperCase()
        }

        // STEP 3 — swap_quote
        for (const call of data.toolCalls) {
          if (call.tool !== 'swap_quote') continue
          const r = call.result
          if (!r || r.success === false) continue
          result.swapQuote = r.outAmount || r.outputAmount || 'N/A'
          result.swapRoute = r.route || r.marketInfos?.[0]?.label || 'Jupiter'
        }

        // STEP 4 — riskSignal from priceChange24h
        if (result.priceChange24h !== 'N/A') {
          const n = parseFloat(
            result.priceChange24h.replace(/[^0-9.-]/g, '')
          )
          if (!isNaN(n)) {
            result.riskSignal = n > 1 ? 'BULLISH' :
                                n < -1 ? 'BEARISH' : 'NEUTRAL'
          }
        }

        // STEP 5 — build analysis if missing
        if (!result.analysis || result.analysis === 'Analysis unavailable.') {
          result.analysis =
            `${result.tokenName} is trading at ` +
            `${result.price} (${result.priceChange24h} 24h). ` +
            `Global volume: ${result.volume24h}. ` +
            `Liquidity score: ${result.liquidityScore}/100.`
        }

        result.toolsUsed = [...new Set(data.toolCalls.map(t => t.tool))]
      }
    }

    // Always override toolsUsed from actual toolCalls
    if (data.toolCalls && data.toolCalls.length > 0) {
      result.toolsUsed = [...new Set(data.toolCalls.map(t => t.tool))]
    }

    // Normalize volume24h format universally
    if (result.volume24h && result.volume24h !== 'N/A') {
      const raw = result.volume24h.replace(/[$,]/g, '').trim()
      if (!/[BMK]$/i.test(raw)) {
        const num = parseFloat(raw)
        if (!isNaN(num)) {
          result.volume24h = '$' + formatVolume(num)
        }
      } else {
        if (!result.volume24h.startsWith('$')) {
          result.volume24h = '$' + result.volume24h
        }
      }
    }

    // Normalize price format universally
    if (result.price && result.price !== 'N/A') {
      if (!result.price.startsWith('$')) {
        result.price = '$' + result.price
      }
    }

    // Normalize priceChange24h format
    if (result.priceChange24h && result.priceChange24h !== 'N/A') {
      const n = parseFloat(
        result.priceChange24h.replace(/[^0-9.-]/g, '')
      )
      if (!isNaN(n)) {
        const sign = n >= 0 ? '+' : ''
        result.priceChange24h = sign + n.toFixed(2) + '%'
      }
    }

    console.log('Sending to frontend:', JSON.stringify(result, null, 2))
    res.json(result)
  } catch (err) {
    return res.status(500).json({ error: true, message: err.message })
  }
}
