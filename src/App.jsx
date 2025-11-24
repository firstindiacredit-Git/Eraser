import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:4000'

let socketInstance

const getSocket = () => {
  if (!socketInstance) {
    socketInstance = io(SOCKET_URL, {
      autoConnect: false,
    })
  }
  return socketInstance
}

function App() {
  const [content, setContent] = useState('')
  const [status, setStatus] = useState('Connecting…')
  const [remoteTyping, setRemoteTyping] = useState(false)
  const [connectionCode, setConnectionCode] = useState('')
  const [inputCode, setInputCode] = useState('')
  const [showTypingPad, setShowTypingPad] = useState(false)
  const [codeLength, setCodeLength] = useState(6)
  const typingTimeoutRef = useRef()
  const localTypingRef = useRef(false)

  useEffect(() => {
    const client = getSocket()
    if (!client.connected) {
      client.connect()
    }

    const handleConnect = () => {
      setStatus('Connected')
    }
    const handleDisconnect = () => setStatus('Reconnecting…')
    const handleSync = (nextValue) => {
      setContent((prev) => (prev === nextValue ? prev : nextValue))
    }
    const handleTyping = (flag) => setRemoteTyping(Boolean(flag))
    const handleJoinSuccess = (code) => {
      setConnectionCode(code)
      setStatus('Connected')
      // Don't hide code input yet, keep it visible
    }
    const handleJoinError = (error) => {
      setStatus(`Error: ${error}`)
    }
    const handleCodeConfig = (config) => {
      if (config && config.length) {
        setCodeLength(config.length)
      }
    }
    const handleUserJoined = (data) => {
      if (data && data.roomSize) {
        // Show typing pad when someone else joins (roomSize > 1)
        if (data.roomSize > 1) {
          setShowTypingPad(true)
          setStatus('Connected')
        }
      }
    }

    client.on('connect', handleConnect)
    client.on('disconnect', handleDisconnect)
    client.on('content:sync', handleSync)
    client.on('typing', handleTyping)
    client.on('join:success', handleJoinSuccess)
    client.on('join:error', handleJoinError)
    client.on('code:config', handleCodeConfig)
    client.on('user:joined', handleUserJoined)

    return () => {
      client.off('connect', handleConnect)
      client.off('disconnect', handleDisconnect)
      client.off('content:sync', handleSync)
      client.off('typing', handleTyping)
      client.off('join:success', handleJoinSuccess)
      client.off('join:error', handleJoinError)
      client.off('code:config', handleCodeConfig)
      client.off('user:joined', handleUserJoined)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }
    }
  }, [])

  const notifyTyping = () => {
    const client = getSocket()
    if (!localTypingRef.current) {
      client.emit('typing', true)
      localTypingRef.current = true
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }

    typingTimeoutRef.current = setTimeout(() => {
      localTypingRef.current = false
      client.emit('typing', false)
    }, 1200)
  }

  const handleContentChange = (event) => {
    const nextValue = event.target.value
    setContent(nextValue)
    getSocket().emit('content:update', nextValue)
    notifyTyping()
  }

  const handleCreateSession = () => {
    const client = getSocket()
    setStatus('Creating session...')
    
    // Handler to receive the connection code
    const handleSessionCreated = (code) => {
      if (code) {
        setConnectionCode(code)
        setStatus('Connected')
        // Keep code input visible, don't switch to typing pad yet
      }
      // Remove this one-time listener
      client.off('join:success', handleSessionCreated)
    }
    
    // Set up listener for the response
    client.once('join:success', handleSessionCreated)
    
    // Ensure we're connected before creating session
    if (client.connected) {
      client.emit('create:session')
    } else {
      // Connect first, then create session
      client.connect()
      
      // Wait for connection and create session
      client.once('connect', () => {
        setTimeout(() => {
          client.emit('create:session')
        }, 100)
      })
    }
  }

  const handleJoinSession = () => {
    const code = inputCode.toUpperCase().trim()
    if (code.length !== codeLength) {
      setStatus(`Connection code must be ${codeLength} characters`)
      return
    }
    const client = getSocket()
    setStatus('Joining session...')
    
    // Handler for when join is successful
    const handleJoinComplete = (joinedCode) => {
      setConnectionCode(joinedCode)
      // When joining, show typing pad immediately since session exists
      setShowTypingPad(true)
      setStatus('Connected')
      client.off('join:success', handleJoinComplete)
    }
    
    client.once('join:success', handleJoinComplete)
    
    if (client.connected) {
      client.emit('join:session', code)
    } else {
      client.connect()
      client.once('connect', () => {
        setTimeout(() => client.emit('join:session', code), 100)
      })
    }
  }

  const handleCopyCode = () => {
    navigator.clipboard.writeText(connectionCode)
    setStatus('Code copied!')
    setTimeout(() => setStatus('Connected'), 2000)
  }

  const handleBack = () => {
    const client = getSocket()
    // Leave current session
    if (connectionCode) {
      client.emit('leave:session')
    }
    // Reset state
    setConnectionCode('')
    setInputCode('')
    setContent('')
    setShowTypingPad(false)
    setStatus('Connected')
  }

  return (
    <main className="app-shell">
      <section className="pad-card">
        <header className="pad-header">
          <div>
            <p className="eyebrow">Shared paste pad</p>
            <h1>Instant text sharing</h1>
          </div>
          <span className={`status-pill status-pill--${status === 'Connected' ? 'ok' : 'warn'}`}>
            {status}
          </span>
        </header>

        {!showTypingPad ? (
          <div className="connection-section">
            <p className="subtitle">
              {connectionCode 
                ? `Share this connection code with others. Waiting for someone to join...`
                : 'Create a new session or join an existing one using a connection code.'}
            </p>
            <div className="connection-actions">
              {!connectionCode ? (
                <button className="btn btn-primary" onClick={handleCreateSession}>
                  Create New Session
                </button>
              ) : (
                <div className="code-display-inline">
                  <div className="code-display">
                    <span className="code-value">{connectionCode}</span>
                    <button className="btn btn-copy" onClick={handleCopyCode}>
                      Copy
                    </button>
                  </div>
                  <p className="waiting-text">Waiting for others to join...</p>
                  <button className="btn btn-back" onClick={handleBack}>
                    ← Back
                  </button>
                </div>
              )}
              {!connectionCode && (
                <div className="join-section">
                  <input
                    type="text"
                    className="code-input"
                    placeholder={`Enter ${codeLength}-digit code`}
                    value={inputCode}
                    onChange={(e) => setInputCode(e.target.value.toUpperCase().slice(0, codeLength))}
                    maxLength={codeLength}
                  />
                  <button className="btn btn-secondary" onClick={handleJoinSession}>
                    Join Session
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="connection-code-display">
              <p className="subtitle">
                Share this connection code with others to collaborate in real time.
              </p>
              <div className="code-display">
                <span className="code-value">{connectionCode || 'Generating...'}</span>
                {connectionCode && (
                  <button className="btn btn-copy" onClick={handleCopyCode}>
                    Copy
                  </button>
                )}
              </div>
              <button className="btn btn-back" onClick={handleBack}>
                ← Back to Create/Join Session
              </button>
            </div>

            <textarea
              className="shared-input"
              value={content}
              placeholder="Start typing or paste something to broadcast it…"
              onChange={handleContentChange}
            />

            <footer className="pad-footer">
              <span>{content.length} characters</span>
              <span className={`typing-indicator ${remoteTyping ? 'typing-indicator--active' : ''}`}>
                {remoteTyping ? 'Someone is typing…' : 'Waiting for collaborators'}
              </span>
            </footer>
          </>
        )}
      </section>
    </main>
  )
}

export default App
