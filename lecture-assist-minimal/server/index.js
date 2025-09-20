import 'dotenv/config'
import express from 'express'
import morgan from 'morgan'
import cors from 'cors'
import { WebSocketServer, WebSocket } from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 4350
const ROOT_DIR = process.env.ROOT_DIR || './storage'
const SAVE_AUDIO = (process.env.SAVE_AUDIO || 'true') === 'true'
const DO_TRANSLATE = (process.env.DO_TRANSLATE || 'true') === 'true'
const TARGET_LANGUAGE = process.env.TARGET_LANGUAGE || 'zh'
const LANGUAGE_HINTS = (process.env.LANGUAGE_HINTS || 'ja').split(',').map(s => s.trim())
const MODEL = process.env.MODEL || 'stt-rt-preview'
const ENABLE_ENDPOINT_DETECTION = (process.env.ENABLE_ENDPOINT_DETECTION || 'true') === 'true'
const SILENCE_FINALIZE_MS = parseInt(process.env.SILENCE_FINALIZE_MS || '2000', 10)
const MAX_SEGMENT_SEC = parseInt(process.env.MAX_SEGMENT_SEC || '10', 10)

const app = express()
app.use(cors())
app.use(morgan('dev'))
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

// Create today folder
function createSessionDir() {
  const today = new Date()
  const d = today.toISOString().slice(0,10).replace(/-/g,'')
  const course = process.env.COURSE_NAME || 'course-default'
  const sessionDir = path.join(ROOT_DIR, `${d}_${course}_${Date.now()}`)
  fs.mkdirSync(path.join(sessionDir, 'audio'), { recursive: true })
  fs.mkdirSync(path.join(sessionDir, 'export'), { recursive: true })
  return sessionDir
}

const sessionDir = createSessionDir()
const transcriptPath = path.join(sessionDir, 'transcript.jsonl')
console.log('[storage] sessionDir =', path.resolve(sessionDir))

// Minimal SRT export (very naive)
app.get('/export/srt', (_req, res) => {
  try {
    const lines = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n') : []
    let idx = 1
    const toTime = ms => {
      const h = String(Math.floor(ms/3600000)).padStart(2,'0')
      const m = String(Math.floor(ms%3600000/60000)).padStart(2,'0')
      const s = String(Math.floor(ms%60000/1000)).padStart(2,'0')
      const t = String(ms%1000).padStart(3,'0')
      return `${h}:${m}:${s},${t}`
    }
    const srt = []
    for (const l of lines) {
      if(!l) continue
      const seg = JSON.parse(l)
      if(!seg.final) continue
      const start = toTime(seg.t0 || 0)
      const end = toTime(seg.t1 || (seg.t0||0) + 2000)
      srt.push(String(idx++))
      srt.push(`${start} --> ${end}`)
      srt.push(`${seg.ja || ''}`)
      srt.push(`${seg.zh || ''}`)
      srt.push('')
    }
    res.setHeader('Content-Type','application/x-subrip')
    res.setHeader('Content-Disposition','attachment; filename="lecture.srt"')
    res.send(srt.join('\n'))
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'export_failed' })
  }
})

// Very small client page (for quick test without Next app)
app.get('/', (_req, res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.end(`<!doctype html>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
  body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:16px;max-width:900px;margin:auto}
  #ja{font-size:20px;white-space:pre-wrap;margin:8px 0;padding:8px;border:1px solid #ddd;border-radius:8px}
  #zh{font-size:20px;white-space:pre-wrap;margin:8px 0;padding:8px;border:1px solid #ddd;border-radius:8px}
  </style>
  <h1>Lecture Assist (Local)</h1>
  <button id="startBtn">🎙️ Start</button>
  <button id="stopBtn" disabled>⏹ Stop</button>
  <div><strong>JA</strong></div>
  <div id="ja"></div>
  <div><strong>ZH</strong></div>
  <div id="zh"></div>
  <script>
  const jaDiv = document.getElementById('ja')
  const zhDiv = document.getElementById('zh')
  let ws, mr, stream

  async function start(){
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, channelCount:1 }, video:false })
    mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 })
    ws = new WebSocket(`ws://${location.hostname}:${%PORT%}/ingest`)
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev)=>{
      try{
        const msg = JSON.parse(ev.data)
        if(msg.type === 'partial' || msg.type === 'final'){
          jaDiv.textContent = msg.ja || jaDiv.textContent
          zhDiv.textContent = msg.zh || zhDiv.textContent
        }
      }catch{}
    }
    mr.ondataavailable = e => e.data.arrayBuffer().then(buf => ws.readyState===1 && ws.send(buf))
    mr.start(1000)
    document.getElementById('startBtn').disabled = true
    document.getElementById('stopBtn').disabled = false
  }
  function stop(){
    mr && mr.stop()
    stream && stream.getTracks().forEach(t=>t.stop())
    ws && ws.close()
    document.getElementById('startBtn').disabled = false
    document.getElementById('stopBtn').disabled = true
  }
  document.getElementById('startBtn').onclick = start
  document.getElementById('stopBtn').onclick = stop
  </script>`
  .replace('%PORT%', PORT)
  )
})

const server = app.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`))

// === WS: /ingest  from browser  -> proxy to Soniox ===
const wss = new (WebSocketServer)({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ingest') {
    wss.handleUpgrade(req, socket, head, (wsClient) => {
      wss.emit('connection', wsClient, req)
    })
  } else {
    socket.destroy()
  }
})

// Simple token aggregator for a dual-pane JA/ZH display.
function makeAggregator() {
  let jaBuff = ''
  let zhBuff = ''
  let t0 = 0
  let lastAudioTsFinal = 0
  return {
    applyTokens(tokens) {
      // tokens: array of {text,is_final,language,translation_status,start_ms,end_ms}
      let dirty = false
      for (const tk of tokens) {
        if (tk.text === '<fin>' || tk.text === '<end>') {
          // finalize: nothing to append; mark boundary
          continue
        }
        // spoken/original tokens for JA
        if ((tk.translation_status === 'original' || tk.translation_status === 'none') && tk.language === 'ja') {
          if (t0 === 0 && typeof tk.start_ms === 'number') t0 = tk.start_ms
          jaBuff += tk.text
          if (tk.is_final) lastAudioTsFinal = tk.end_ms ?? lastAudioTsFinal
          dirty = true
        }
        // translation tokens for ZH
        if (tk.translation_status === 'translation' && tk.language === 'zh') {
          zhBuff += tk.text
          dirty = true
        }
      }
      return dirty
    },
    getPartial(){ return { ja: jaBuff, zh: zhBuff, t0, t1: lastAudioTsFinal } },
    finalizeSegment(){
      const seg = { ...this.getPartial(), final: true, id: uuidv4() }
      jaBuff = ''; zhBuff = ''; t0 = 0; lastAudioTsFinal = 0
      return seg
    }
  }
}

wss.on('connection', (client) => {
  const agg = makeAggregator()
  const clientId = uuidv4()
  const recordDir = path.join(sessionDir, 'audio')
  let lastChunkAt = Date.now()
  let soniox

  // connect to Soniox WS
  function connectSoniox(){
    const sx = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
    sx.on('open', () => {
      const config = {
        api_key: process.env.SONIOX_API_KEY,
        model: MODEL,
        audio_format: 'auto',
        language_hints: LANGUAGE_HINTS,
        enable_endpoint_detection: ENABLE_ENDPOINT_DETECTION,
      }
      if (DO_TRANSLATE) {
        config.translation = { type: 'one_way', target_language: TARGET_LANGUAGE }
      }
      sx.send(JSON.stringify(config))
      console.log('[soniox] opened')
    })
    sx.on('message', (data) => {
      try{
        const msg = JSON.parse(data.toString())
        if (Array.isArray(msg.tokens) && msg.tokens.length) {
          const changed = agg.applyTokens(msg.tokens)
          if (changed) {
            const partial = { type: 'partial', ...agg.getPartial() }
            client.send(JSON.stringify(partial))
          }
          // detect end/finalize markers
          const hasEnd = msg.tokens.some(t => t.text === '<end>' || t.text === '<fin>')
          if (hasEnd) {
            const seg = agg.finalizeSegment()
                        fs.appendFileSync(transcriptPath, JSON.stringify(seg) + '\n')
            client.send(JSON.stringify({ type: 'final', ...seg }))
          }
        }
      }catch(e){
        console.error('[soniox] parse error', e)
      }
    })
    sx.on('close', ()=> console.log('[soniox] closed'))
    sx.on('error', (e)=> console.error('[soniox] error', e.message))
    return sx
  }

  soniox = connectSoniox()

  client.on('message', (buf) => {
    lastChunkAt = Date.now()
    // persist chunk if needed
    if (SAVE_AUDIO) {
      try {
        const fname = path.join(recordDir, `${Date.now()}_${clientId}.webm`)
        fs.writeFile(fname, Buffer.from(buf), { flag: 'wx' }, ()=>{})
      } catch {}
    }
    // forward to soniox
    if (soniox && soniox.readyState === WebSocket.OPEN) {
      soniox.send(buf)
    }
  })

  // silence-based finalize and max segment timer
  const interval = setInterval(()=>{
    const now = Date.now()
    if (now - lastChunkAt > SILENCE_FINALIZE_MS) {
      if (soniox && soniox.readyState === WebSocket.OPEN) {
        soniox.send(JSON.stringify({ type: 'finalize' }))
      }
      lastChunkAt = now
    }
  }, 500)

  client.on('close', () => {
    clearInterval(interval)
    if (soniox && soniox.readyState === WebSocket.OPEN) {
      soniox.close()
    }
  })
})
