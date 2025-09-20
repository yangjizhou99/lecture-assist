import { useEffect, useRef, useState } from 'react'

export default function Home(){
  // 实时转录状态
  const [running, setRunning] = useState(false)
  const [ja, setJa] = useState('')
  const [zh, setZh] = useState('')
  const [jaHistory, setJaHistory] = useState([])
  const [zhHistory, setZhHistory] = useState([])
  const mrRef = useRef(null)
  const wsRef = useRef(null)
  const streamRef = useRef(null)

  // 异步转录状态
  const [mode, setMode] = useState('realtime') // 'realtime' 或 'async'
  const [uploading, setUploading] = useState(false)
  const [currentJob, setCurrentJob] = useState(null)
  const [jobStatus, setJobStatus] = useState('')
  const [jobProgress, setJobProgress] = useState(0)
  const [asyncJa, setAsyncJa] = useState('')
  const [asyncZh, setAsyncZh] = useState('')
  const fileInputRef = useRef(null)
  const pollingIntervalRef = useRef(null)

  async function start(){
    const host = window.location.hostname
    const port = 4350 // server port
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, channelCount:1 }, video:false })
    streamRef.current = stream
    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 })
    const ws = new WebSocket(`ws://${host}:${port}/ingest`)
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev)=>{
      try{
        const msg = JSON.parse(ev.data)
        if(msg.type === 'partial' || msg.type === 'final'){
          // 累积显示文本，而不是覆盖
          if(typeof msg.ja === 'string' && msg.ja.trim()) {
            const jaText = msg.ja.trim()
            setJa(prev => {
              if(prev && !prev.endsWith(jaText)) {
                return prev + ' ' + jaText
              }
              return jaText
            })
          }
          if(typeof msg.zh === 'string' && msg.zh.trim()) {
            const zhText = msg.zh.trim()
            setZh(prev => {
              if(prev && !prev.endsWith(zhText)) {
                return prev + ' ' + zhText
              }
              return zhText
            })
          }
        }
      }catch{}
    }
    mr.ondataavailable = e => e.data.arrayBuffer().then(buf => ws.readyState===1 && ws.send(buf))
    mr.start(1000)
    mrRef.current = mr
    wsRef.current = ws
    setRunning(true)
  }

  function stop(){
    mrRef.current && mrRef.current.stop()
    streamRef.current && streamRef.current.getTracks().forEach(t=>t.stop())
    wsRef.current && wsRef.current.close()
    setRunning(false)
  }

  function clearText(){
    setJa('')
    setZh('')
    setAsyncJa('')
    setAsyncZh('')
  }

  // 异步转录相关函数
  async function handleFileUpload(event) {
    const file = event.target.files[0]
    if (!file) return

    setUploading(true)
    setJobStatus('上传中...')
    setJobProgress(0)

    try {
      const formData = new FormData()
      formData.append('audio', file)

      const response = await fetch(`http://${window.location.hostname}:4350/api/upload`, {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        throw new Error('上传失败')
      }

      const result = await response.json()
      setCurrentJob(result.jobId)
      setJobStatus('转录中...')
      setJobProgress(10)

      // 开始轮询状态
      startPolling(result.jobId)

    } catch (error) {
      console.error('Upload error:', error)
      setJobStatus('上传失败: ' + error.message)
      setUploading(false)
    }
  }

  function startPolling(jobId) {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
    }

    pollingIntervalRef.current = setInterval(async () => {
      try {
        const response = await fetch(`http://${window.location.hostname}:4350/api/status/${jobId}`)
        if (!response.ok) return

        const job = await response.json()
        setJobStatus(job.status)
        setJobProgress(job.progress || 0)

        if (job.status === 'completed') {
          // 获取结果
          const resultResponse = await fetch(`http://${window.location.hostname}:4350/api/result/${jobId}`)
          if (resultResponse.ok) {
            const result = await resultResponse.json()
            setAsyncJa(result.result.ja)
            setAsyncZh(result.result.zh)
          }
          setUploading(false)
          clearInterval(pollingIntervalRef.current)
        } else if (job.status === 'error') {
          setJobStatus('转录失败: ' + (job.error || '未知错误'))
          setUploading(false)
          clearInterval(pollingIntervalRef.current)
        }
      } catch (error) {
        console.error('Polling error:', error)
      }
    }, 2000)
  }

  function stopPolling() {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
  }

  // 清理轮询
  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [])

  return (
    <div className="container">
      <h1>Lecture Assist <small>(Local, Soniox)</small></h1>
      
      {/* 模式切换 */}
      <div className="mode-switch">
        <button 
          className={mode === 'realtime' ? 'active' : ''} 
          onClick={() => setMode('realtime')}
        >
          实时转录
        </button>
        <button 
          className={mode === 'async' ? 'active' : ''} 
          onClick={() => setMode('async')}
        >
          异步转录
        </button>
      </div>

      {/* 实时转录模式 */}
      {mode === 'realtime' && (
        <>
          <div className="row">
            {!running ? <button onClick={start}>🎙️ Start</button> : <button onClick={stop}>⏹ Stop</button>}
            <button onClick={clearText}>🗑️ Clear</button>
            <a href="http://localhost:4350/export/srt" target="_blank" rel="noreferrer">
              <button>⬇️ Export SRT</button>
            </a>
          </div>
          <h2>JA</h2>
          <div className="panel">{ja}</div>
          <h2>ZH</h2>
          <div className="panel">{zh}</div>
          <p><small>Open this page on your phone/tablet in the same Wi-Fi, it will stream mic audio to your laptop server and show captions.</small></p>
        </>
      )}

      {/* 异步转录模式 */}
      {mode === 'async' && (
        <>
          <div className="upload-section">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="upload-btn"
            >
              {uploading ? '处理中...' : '📁 选择音频文件'}
            </button>
            
            {currentJob && (
              <div className="job-status">
                <div className="status-text">{jobStatus}</div>
                <div className="progress-bar">
                  <div 
                    className="progress-fill" 
                    style={{ width: `${jobProgress}%` }}
                  ></div>
                </div>
                <div className="progress-text">{jobProgress}%</div>
              </div>
            )}
          </div>

          <h2>JA</h2>
          <div className="panel">{asyncJa}</div>
          <h2>ZH</h2>
          <div className="panel">{asyncZh}</div>
          
          <p><small>支持音频格式: MP3, WAV, M4A, WEBM, OGG 等</small></p>
        </>
      )}
    </div>
  )
}
