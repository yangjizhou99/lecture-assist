import { useEffect, useRef, useState } from 'react'

export default function Home(){
  const [running, setRunning] = useState(false)
  const [ja, setJa] = useState('')
  const [zh, setZh] = useState('')
  const mrRef = useRef(null)
  const wsRef = useRef(null)
  const streamRef = useRef(null)

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
          if(typeof msg.ja === 'string') setJa(msg.ja)
          if(typeof msg.zh === 'string') setZh(msg.zh)
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

  return (
    <div className="container">
      <h1>Lecture Assist <small>(Local, Soniox)</small></h1>
      <div className="row">
        {!running ? <button onClick={start}>🎙️ Start</button> : <button onClick={stop}>⏹ Stop</button>}
        <a href="http://localhost:4350/export/srt" target="_blank" rel="noreferrer">
          <button>⬇️ Export SRT</button>
        </a>
      </div>
      <h1>JA</h1>
      <div className="panel">{ja}</div>
      <h1>ZH</h1>
      <div className="panel">{zh}</div>
      <p><small>Open this page on your phone/tablet in the same Wi-Fi, it will stream mic audio to your laptop server and show captions.</small></p>
    </div>
  )
}
