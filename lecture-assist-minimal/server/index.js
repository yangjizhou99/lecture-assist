import dotenv from 'dotenv'
import express from 'express'
import morgan from 'morgan'
import cors from 'cors'
import { WebSocketServer, WebSocket } from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import multer from 'multer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 手动加载.env文件，指定完整路径
dotenv.config({ path: path.join(__dirname, '.env') })
import { v4 as uuidv4 } from 'uuid'

// 调试环境变量
console.log('[debug] SONIOX_API_KEY:', process.env.SONIOX_API_KEY ? '已设置' : '未设置')
console.log('[debug] 当前工作目录:', process.cwd())
console.log('[debug] .env文件路径:', path.join(process.cwd(), '.env'))

// 临时硬编码API密钥进行测试
const SONIOX_API_KEY = process.env.SONIOX_API_KEY || 'cf257c4fb7415c648196579495a9b0f80a0b0ef462833be781fc6fca6788a1f5'
console.log('[debug] 最终使用的API密钥:', SONIOX_API_KEY ? '已设置' : '未设置')

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

// 配置multer用于文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(sessionDir, 'uploads')
    fs.mkdirSync(uploadDir, { recursive: true })
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname))
  }
})
const upload = multer({ storage: storage })

// 存储转录任务状态
const transcriptionJobs = new Map()

app.get('/health', (_req, res) => res.json({ ok: true }))

// 异步转录相关API
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' })
    }

    const jobId = uuidv4()
    const filePath = req.file.path
    
    // 初始化任务状态
    transcriptionJobs.set(jobId, {
      id: jobId,
      status: 'uploading',
      filePath: filePath,
      createdAt: new Date().toISOString(),
      progress: 0
    })

    // 异步上传到Soniox并开始转录
    processTranscriptionAsync(jobId, filePath)
    
    res.json({ 
      jobId: jobId,
      status: 'uploading',
      message: '文件上传成功，开始转录...'
    })
  } catch (error) {
    console.error('Upload error:', error)
    res.status(500).json({ error: 'Upload failed' })
  }
})

// 获取转录状态
app.get('/api/status/:jobId', (req, res) => {
  const jobId = req.params.jobId
  const job = transcriptionJobs.get(jobId)
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' })
  }
  
  res.json(job)
})

// 获取转录结果
app.get('/api/result/:jobId', (req, res) => {
  const jobId = req.params.jobId
  const job = transcriptionJobs.get(jobId)
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' })
  }
  
  if (job.status !== 'completed') {
    return res.status(400).json({ error: 'Transcription not completed yet' })
  }
  
  res.json({
    jobId: jobId,
    status: job.status,
    result: job.result
  })
})

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
  const html = `<!doctype html>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
  body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:16px;max-width:900px;margin:auto}
  #ja{font-size:20px;white-space:pre-wrap;margin:8px 0;padding:8px;border:1px solid #ddd;border-radius:8px;min-height:100px;background:#fafafa}
  #zh{font-size:20px;white-space:pre-wrap;margin:8px 0;padding:8px;border:1px solid #ddd;border-radius:8px;min-height:100px;background:#fafafa}
  .mode-switch{display:flex;gap:4px;margin:16px 0;border:1px solid #ddd;border-radius:8px;overflow:hidden;width:fit-content}
  .mode-switch button{flex:1;border:none;border-radius:0;background:#f8f8f8;padding:12px 24px;font-weight:500;cursor:pointer}
  .mode-switch button.active{background:#007bff;color:white}
  .mode-switch button:hover:not(.active){background:#e9ecef}
  .upload-section{margin:16px 0;padding:20px;border:2px dashed #ddd;border-radius:8px;text-align:center;background:#fafafa}
  .upload-btn{padding:12px 24px;font-size:16px;background:#28a745;color:white;border:none;border-radius:6px;cursor:pointer}
  .upload-btn:disabled{background:#6c757d;cursor:not-allowed}
  .job-status{margin:16px 0;padding:16px;background:#e3f2fd;border-radius:8px;border-left:4px solid #2196f3}
  .progress-bar{width:100%;height:8px;background:#e0e0e0;border-radius:4px;overflow:hidden;margin:8px 0}
  .progress-fill{height:100%;background:linear-gradient(90deg,#2196f3,#21cbf3);transition:width 0.3s ease}
  button{padding:8px 12px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;margin:4px}
  button:hover{background:#f5f5f5}
  button:disabled{opacity:0.6;cursor:not-allowed}
  </style>
  <h1>Lecture Assist (Local)</h1>
  
  <!-- 模式切换 -->
  <div class="mode-switch">
    <button id="realtimeBtn" class="active">实时转录</button>
    <button id="asyncBtn">异步转录</button>
  </div>

  <!-- 实时转录模式 -->
  <div id="realtimeMode">
    <button id="startBtn">🎙️ Start</button>
    <button id="stopBtn" disabled>⏹ Stop</button>
    <button id="clearBtn">🗑️ Clear</button>
    <div><strong>JA</strong></div>
    <div id="ja"></div>
    <div><strong>ZH</strong></div>
    <div id="zh"></div>
  </div>

  <!-- 异步转录模式 -->
  <div id="asyncMode" style="display:none">
    <div class="upload-section">
      <input type="file" id="fileInput" accept="audio/*" style="display:none">
      <button id="uploadBtn" class="upload-btn">📁 选择音频文件</button>
      <div id="jobStatus" class="job-status" style="display:none">
        <div id="statusText">处理中...</div>
        <div class="progress-bar">
          <div id="progressFill" class="progress-fill" style="width:0%"></div>
        </div>
        <div id="progressText">0%</div>
      </div>
    </div>
    <div><strong>JA</strong></div>
    <div id="asyncJa"></div>
    <div><strong>ZH</strong></div>
    <div id="asyncZh"></div>
    <p><small>支持音频格式: MP3, WAV, M4A, WEBM, OGG 等</small></p>
  </div>
  <script>
  const jaDiv = document.getElementById('ja')
  const zhDiv = document.getElementById('zh')
  const asyncJaDiv = document.getElementById('asyncJa')
  const asyncZhDiv = document.getElementById('asyncZh')
  let ws, mr, stream
  let currentJob = null
  let pollingInterval = null

  // 模式切换
  document.getElementById('realtimeBtn').onclick = () => {
    document.getElementById('realtimeMode').style.display = 'block'
    document.getElementById('asyncMode').style.display = 'none'
    document.getElementById('realtimeBtn').classList.add('active')
    document.getElementById('asyncBtn').classList.remove('active')
  }

  document.getElementById('asyncBtn').onclick = () => {
    document.getElementById('realtimeMode').style.display = 'none'
    document.getElementById('asyncMode').style.display = 'block'
    document.getElementById('asyncBtn').classList.add('active')
    document.getElementById('realtimeBtn').classList.remove('active')
  }

  // 异步转录功能
  document.getElementById('uploadBtn').onclick = () => {
    document.getElementById('fileInput').click()
  }

  document.getElementById('fileInput').onchange = async (event) => {
    const file = event.target.files[0]
    if (!file) return

    document.getElementById('uploadBtn').disabled = true
    document.getElementById('uploadBtn').textContent = '处理中...'
    document.getElementById('jobStatus').style.display = 'block'
    document.getElementById('statusText').textContent = '上传中...'
    document.getElementById('progressFill').style.width = '0%'
    document.getElementById('progressText').textContent = '0%'

    try {
      const formData = new FormData()
      formData.append('audio', file)

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        throw new Error('上传失败')
      }

      const result = await response.json()
      currentJob = result.jobId
      document.getElementById('statusText').textContent = '转录中...'
      document.getElementById('progressFill').style.width = '10%'
      document.getElementById('progressText').textContent = '10%'

      // 开始轮询状态
      startPolling(result.jobId)

    } catch (error) {
      console.error('Upload error:', error)
      document.getElementById('statusText').textContent = '上传失败: ' + error.message
      document.getElementById('uploadBtn').disabled = false
      document.getElementById('uploadBtn').textContent = '📁 选择音频文件'
    }
  }

  function startPolling(jobId) {
    if (pollingInterval) {
      clearInterval(pollingInterval)
    }

    pollingInterval = setInterval(async () => {
      try {
        const response = await fetch('/api/status/' + jobId)
        if (!response.ok) return

        const job = await response.json()
        document.getElementById('statusText').textContent = job.status
        document.getElementById('progressFill').style.width = (job.progress || 0) + '%'
        document.getElementById('progressText').textContent = (job.progress || 0) + '%'

        if (job.status === 'completed') {
          // 获取结果
          const resultResponse = await fetch('/api/result/' + jobId)
          if (resultResponse.ok) {
            const result = await resultResponse.json()
            asyncJaDiv.textContent = result.result.ja
            asyncZhDiv.textContent = result.result.zh
          }
          document.getElementById('uploadBtn').disabled = false
          document.getElementById('uploadBtn').textContent = '📁 选择音频文件'
          clearInterval(pollingInterval)
        } else if (job.status === 'error') {
          document.getElementById('statusText').textContent = '转录失败: ' + (job.error || '未知错误')
          document.getElementById('uploadBtn').disabled = false
          document.getElementById('uploadBtn').textContent = '📁 选择音频文件'
          clearInterval(pollingInterval)
        }
      } catch (error) {
        console.error('Polling error:', error)
      }
    }, 2000)
  }

  async function start(){
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, channelCount:1 }, video:false })
      mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 })
      ws = new WebSocket('ws://' + location.hostname + ':' + ${PORT} + '/ingest')
      ws.binaryType = 'arraybuffer'
      
      ws.onopen = () => {
        console.log('WebSocket connected')
      }
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error)
        alert('连接失败，请检查服务器是否运行')
      }
      
      ws.onclose = () => {
        console.log('WebSocket closed')
      }
      
      ws.onmessage = (ev)=>{
        try{
          const msg = JSON.parse(ev.data)
          if(msg.type === 'partial' || msg.type === 'final'){
            // 清理和格式化文本
            const jaText = (msg.ja || '').trim().replace(/\s+/g, ' ')
            const zhText = (msg.zh || '').trim().replace(/\s+/g, ' ')
            
            // 累积显示文本，而不是覆盖
            if(jaText) {
              const currentJa = jaDiv.textContent.trim()
              if(currentJa && !currentJa.endsWith(jaText)) {
                jaDiv.textContent = currentJa + ' ' + jaText
              } else if(!currentJa) {
                jaDiv.textContent = jaText
              }
            }
            if(zhText) {
              const currentZh = zhDiv.textContent.trim()
              if(currentZh && !currentZh.endsWith(zhText)) {
                zhDiv.textContent = currentZh + ' ' + zhText
              } else if(!currentZh) {
                zhDiv.textContent = zhText
              }
            }
          } else if(msg.type === 'error'){
            console.error('Server error:', msg.error)
            alert('服务器错误: ' + msg.error)
            stop()
          }
        }catch(e){
          console.error('Parse error:', e)
        }
      }
      
      mr.ondataavailable = e => e.data.arrayBuffer().then(buf => ws.readyState===1 && ws.send(buf))
      mr.start(1000)
      document.getElementById('startBtn').disabled = true
      document.getElementById('stopBtn').disabled = false
    } catch (error) {
      console.error('Start error:', error)
      alert('启动失败: ' + error.message)
    }
  }
  function stop(){
    mr && mr.stop()
    stream && stream.getTracks().forEach(t=>t.stop())
    ws && ws.close()
    document.getElementById('startBtn').disabled = false
    document.getElementById('stopBtn').disabled = true
  }
  function clearText(){
    jaDiv.textContent = ''
    zhDiv.textContent = ''
    asyncJaDiv.textContent = ''
    asyncZhDiv.textContent = ''
  }

  document.getElementById('startBtn').onclick = start
  document.getElementById('stopBtn').onclick = stop
  document.getElementById('clearBtn').onclick = clearText
  </script>`
  res.end(html)
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

// Enhanced token aggregator with deduplication
function makeAggregator() {
  let jaBuff = ''
  let zhBuff = ''
  let t0 = 0
  let lastAudioTsFinal = 0
  let lastJaText = ''
  let lastZhText = ''
  
  return {
    applyTokens(tokens) {
      // tokens: array of {text,is_final,language,translation_status,start_ms,end_ms}
      let dirty = false
      let currentJaText = ''
      let currentZhText = ''
      
      for (const tk of tokens) {
        if (tk.text === '<fin>' || tk.text === '<end>') {
          continue
        }
        
        // spoken/original tokens for JA
        if ((tk.translation_status === 'original' || tk.translation_status === 'none') && tk.language === 'ja') {
          if (t0 === 0 && typeof tk.start_ms === 'number') t0 = tk.start_ms
          currentJaText += tk.text
          if (tk.is_final) lastAudioTsFinal = tk.end_ms ?? lastAudioTsFinal
        }
        
        // translation tokens for ZH
        if (tk.translation_status === 'translation' && tk.language === 'zh') {
          currentZhText += tk.text
        }
      }
      
      // 只有当文本真正改变时才更新
      if (currentJaText !== lastJaText) {
        jaBuff = currentJaText
        lastJaText = currentJaText
        dirty = true
      }
      
      if (currentZhText !== lastZhText) {
        zhBuff = currentZhText
        lastZhText = currentZhText
        dirty = true
      }
      
      return dirty
    },
    getPartial(){ 
      return { 
        ja: jaBuff.trim(), 
        zh: zhBuff.trim(), 
        t0, 
        t1: lastAudioTsFinal 
      } 
    },
    finalizeSegment(){
      const seg = { 
        ...this.getPartial(), 
        final: true, 
        id: uuidv4() 
      }
      jaBuff = ''; zhBuff = ''; t0 = 0; lastAudioTsFinal = 0
      lastJaText = ''; lastZhText = ''
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
        api_key: SONIOX_API_KEY,
        model: MODEL,
        audio_format: 'auto',
        language_hints: LANGUAGE_HINTS,
        enable_language_identification: true,
        enable_speaker_diarization: true,
        enable_endpoint_detection: ENABLE_ENDPOINT_DETECTION,
      }
      console.log('[debug] 发送到Soniox的配置:', JSON.stringify(config, null, 2))
      if (DO_TRANSLATE) {
        config.translation = { 
          type: 'one_way', 
          target_language: TARGET_LANGUAGE 
        }
      }
      sx.send(JSON.stringify(config))
      console.log('[soniox] opened')
    })
    sx.on('message', (data) => {
      try{
        const msg = JSON.parse(data.toString())
        
        // 处理错误响应
        if (msg.error_code) {
          console.error('[soniox] API error:', msg.error_code, msg.error_message)
          client.send(JSON.stringify({ 
            type: 'error', 
            error: msg.error_message || 'Soniox API error' 
          }))
          return
        }
        
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
        client.send(JSON.stringify({ 
          type: 'error', 
          error: 'Failed to parse Soniox response' 
        }))
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

// 异步转录处理函数
async function processTranscriptionAsync(jobId, filePath) {
  try {
    const job = transcriptionJobs.get(jobId)
    if (!job) return

    // 更新状态为处理中
    job.status = 'processing'
    job.progress = 10
    transcriptionJobs.set(jobId, job)

    // 1. 上传文件到Soniox Files API
    console.log(`[async] 开始上传文件: ${filePath}`)
    const fileId = await uploadFileToSoniox(filePath)
    
    job.progress = 30
    transcriptionJobs.set(jobId, job)

    // 2. 创建转录任务
    console.log(`[async] 创建转录任务，文件ID: ${fileId}`)
    const transcriptionId = await createTranscriptionJob(fileId)
    
    job.progress = 50
    job.transcriptionId = transcriptionId
    transcriptionJobs.set(jobId, job)

    // 3. 轮询转录状态
    console.log(`[async] 开始轮询转录状态: ${transcriptionId}`)
    await pollTranscriptionStatus(jobId, transcriptionId)

  } catch (error) {
    console.error(`[async] 转录失败 (${jobId}):`, error)
    const job = transcriptionJobs.get(jobId)
    if (job) {
      job.status = 'error'
      job.error = error.message
      transcriptionJobs.set(jobId, job)
    }
  }
}

// 上传文件到Soniox Files API
async function uploadFileToSoniox(filePath) {
  const formData = new FormData()
  const fileBuffer = fs.readFileSync(filePath)
  const blob = new Blob([fileBuffer])
  formData.append('file', blob, path.basename(filePath))

  const response = await fetch('https://api.soniox.com/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SONIOX_API_KEY}`
    },
    body: formData
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`文件上传失败: ${response.status} ${errorText}`)
  }

  const result = await response.json()
  return result.id
}

// 创建转录任务
async function createTranscriptionJob(fileId) {
  const config = {
    file_id: fileId,
    model: 'stt-async-preview',
    language_hints: LANGUAGE_HINTS,
    enable_language_identification: true,
    enable_speaker_diarization: true,
    client_reference_id: `lecture-assist-${Date.now()}`
  }

  if (DO_TRANSLATE) {
    config.translation = {
      type: 'one_way',
      target_language: TARGET_LANGUAGE
    }
  }

  const response = await fetch('https://api.soniox.com/v1/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SONIOX_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(config)
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`创建转录任务失败: ${response.status} ${errorText}`)
  }

  const result = await response.json()
  return result.id
}

// 轮询转录状态
async function pollTranscriptionStatus(jobId, transcriptionId) {
  const job = transcriptionJobs.get(jobId)
  if (!job) return

  while (true) {
    try {
      const response = await fetch(`https://api.soniox.com/v1/transcriptions/${transcriptionId}`, {
        headers: {
          'Authorization': `Bearer ${SONIOX_API_KEY}`
        }
      })

      if (!response.ok) {
        throw new Error(`获取转录状态失败: ${response.status}`)
      }

      const data = await response.json()
      
      if (data.status === 'completed') {
        // 获取转录结果
        const resultResponse = await fetch(`https://api.soniox.com/v1/transcriptions/${transcriptionId}/transcript`, {
          headers: {
            'Authorization': `Bearer ${SONIOX_API_KEY}`
          }
        })

        if (!resultResponse.ok) {
          throw new Error(`获取转录结果失败: ${resultResponse.status}`)
        }

        const result = await resultResponse.json()
        
        // 处理结果，分离日语和中文
        const processedResult = processTranscriptionResult(result)
        
        job.status = 'completed'
        job.progress = 100
        job.result = processedResult
        job.completedAt = new Date().toISOString()
        transcriptionJobs.set(jobId, job)

        console.log(`[async] 转录完成: ${jobId}`)
        break

      } else if (data.status === 'error') {
        throw new Error(data.error_message || '转录失败')
      }

      // 更新进度
      job.progress = Math.min(90, job.progress + 10)
      transcriptionJobs.set(jobId, job)

      // 等待2秒后再次检查
      await new Promise(resolve => setTimeout(resolve, 2000))

    } catch (error) {
      console.error(`[async] 轮询错误 (${jobId}):`, error)
      job.status = 'error'
      job.error = error.message
      transcriptionJobs.set(jobId, job)
      break
    }
  }
}

// 处理转录结果，分离日语和中文
function processTranscriptionResult(result) {
  const tokens = result.tokens || []
  let jaText = ''
  let zhText = ''
  let currentSpeaker = null
  let currentLanguage = null

  for (const token of tokens) {
    const text = token.text || ''
    const speaker = token.speaker
    const language = token.language

    // 处理说话人变化
    if (speaker !== undefined && speaker !== currentSpeaker) {
      if (currentSpeaker !== null) {
        jaText += '\n\n'
        zhText += '\n\n'
      }
      currentSpeaker = speaker
      currentLanguage = null
      jaText += `Speaker ${currentSpeaker}: `
      zhText += `Speaker ${currentSpeaker}: `
    }

    // 处理语言变化
    if (language !== undefined && language !== currentLanguage) {
      currentLanguage = language
      if (language === 'ja') {
        jaText += text
      } else if (language === 'zh') {
        zhText += text
      }
    } else {
      // 根据翻译状态判断
      if (token.translation_status === 'original' || token.translation_status === 'none') {
        jaText += text
      } else if (token.translation_status === 'translation') {
        zhText += text
      }
    }
  }

  return {
    ja: jaText.trim(),
    zh: zhText.trim(),
    tokens: tokens
  }
}
