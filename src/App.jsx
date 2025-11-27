import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import Editor from 'react-simple-code-editor'
import { highlight, languages } from 'prismjs'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-css'
import 'prismjs/components/prism-markup'
import 'prismjs/themes/prism-tomorrow.css'
import './App.css'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:4000'
const SESSION_STORAGE_KEY = 'toolzbuy:activeSession'
const CLIENT_ID_STORAGE_KEY = 'toolzbuy:clientId'
const DISPLAY_NAME_STORAGE_KEY = 'toolzbuy:displayName'
const LANDING_TYPING_PHRASES = [
  'Pair program from anywhere.',
  'Ship reviews while you call.',
  'Demo your fix in real time.',
]
const FALLBACK_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const generateClientId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2, 12)
}

const safeLocalStorage = () => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const getStoredClientId = () => {
  const storage = safeLocalStorage()
  if (!storage) {
    return generateClientId()
  }
  const existing = storage.getItem(CLIENT_ID_STORAGE_KEY)
  if (existing) {
    return existing
  }
  const next = generateClientId()
  storage.setItem(CLIENT_ID_STORAGE_KEY, next)
  return next
}

const getStoredDisplayName = () => {
  const storage = safeLocalStorage()
  if (!storage) return ''
  return storage.getItem(DISPLAY_NAME_STORAGE_KEY) ?? ''
}

const saveDisplayName = (value) => {
  const storage = safeLocalStorage()
  if (!storage) return
  storage.setItem(DISPLAY_NAME_STORAGE_KEY, value ?? '')
}

const saveSessionMetadata = (code, role = 'guest') => {
  const storage = safeLocalStorage()
  if (!storage || !code) return
  storage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      code,
      role,
      updatedAt: Date.now(),
    })
  )
}

const loadSessionMetadata = () => {
  const storage = safeLocalStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const clearSessionMetadata = () => {
  const storage = safeLocalStorage()
  if (!storage) return
  storage.removeItem(SESSION_STORAGE_KEY)
}

let socketInstance

const getSocket = () => {
  if (!socketInstance) {
    socketInstance = io(SOCKET_URL, {
      autoConnect: false,
      auth: {
        clientId: getStoredClientId(),
      },
    })
  }
  return socketInstance
}

function App() {
  const initialSession = useMemo(() => loadSessionMetadata(), [])
  const [content, setContent] = useState('')
  const [status, setStatus] = useState(
    initialSession?.role === 'creator'
      ? 'Waiting for another user...'
      : 'Connecting…'
  )
  const [remoteTyping, setRemoteTyping] = useState(false)
  const [connectionCode, setConnectionCode] = useState(
    () => initialSession?.code || ''
  )
  const [inputCode, setInputCode] = useState('')
  const [showTypingPad, setShowTypingPad] = useState(false)
  const [codeLength, setCodeLength] = useState(6)
  const [codeBlocks, setCodeBlocks] = useState([{ id: 0, content: '', name: 'Block 1' }])
  const [showShareDropdown, setShowShareDropdown] = useState(
    () => Boolean(initialSession?.code && initialSession.role === 'creator')
  )
  const [connectedUsers, setConnectedUsers] = useState([])
  const [displayName, setDisplayName] = useState(() => getStoredDisplayName() || '')
  const [pendingName, setPendingName] = useState(() =>
    initialSession?.role === 'creator' ? getStoredDisplayName() || '' : ''
  )
  const [isSavingName, setIsSavingName] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isOfflineSession, setIsOfflineSession] = useState(false)
  const [clientIdValue] = useState(() => getStoredClientId())
  const clientIdRef = useRef(clientIdValue)
  const shareDropdownRef = useRef()
  const typingTimeoutRef = useRef()
  const localTypingRef = useRef(false)
  const createSessionFallbackRef = useRef()
  const offlineRetryIntervalRef = useRef()
  const landingVideoRefs = useRef([])
  const [landingTypingIndex, setLandingTypingIndex] = useState(0)
  const [landingTypingText, setLandingTypingText] = useState('')
  const [isDeletingLandingText, setIsDeletingLandingText] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [activeBlockId, setActiveBlockId] = useState(0)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])

  const updateParticipants = useCallback(
    (participants) => {
      if (!Array.isArray(participants)) {
        setConnectedUsers([])
        return
      }
      setConnectedUsers(participants)
      const me = participants.find(
        (entry) => entry.clientId === clientIdRef.current
      )
      if (me?.name) {
        setDisplayName(me.name)
      }
    },
    []
  )

  const openShareDropdown = useCallback(() => {
    setShowShareDropdown(true)
    setPendingName((prev) => (prev ? prev : displayName || ''))
  }, [displayName])

  const closeShareDropdown = useCallback(() => {
    setShowShareDropdown(false)
    setPendingName('')
  }, [])

  const generateLocalConnectionCode = useCallback(() => {
    if (!codeLength || codeLength <= 0) {
      return ''
    }
    let code = ''
    for (let i = 0; i < codeLength; i += 1) {
      const idx = Math.floor(Math.random() * FALLBACK_CODE_CHARS.length)
      code += FALLBACK_CODE_CHARS[idx % FALLBACK_CODE_CHARS.length]
    }
    return code
  }, [codeLength])

  const clearCreateSessionFallback = useCallback(() => {
    if (createSessionFallbackRef.current) {
      clearTimeout(createSessionFallbackRef.current)
      createSessionFallbackRef.current = null
    }
  }, [])

  const clearOfflineRetryTimer = useCallback(() => {
    if (offlineRetryIntervalRef.current) {
      clearInterval(offlineRetryIntervalRef.current)
      offlineRetryIntervalRef.current = null
    }
  }, [])

  const activateOfflineSession = useCallback(() => {
    const offlineCode = generateLocalConnectionCode()
    if (!offlineCode) {
      setStatus('Unable to generate offline code. Try again.')
      return
    }
    setIsOfflineSession(true)
    setConnectionCode(offlineCode)
    setInputCode(offlineCode)
    setStatus('Offline mode: sharing placeholder while auto-retrying…')
    setShowTypingPad(false)
    setConnectedUsers([])
    clearSessionMetadata()
    closeShareDropdown()
  }, [closeShareDropdown, generateLocalConnectionCode])

  useEffect(() => {
    if (showTypingPad) {
      return
    }
    let interactionHandler

    const playAllVideos = () => {
      landingVideoRefs.current.forEach((video) => {
        if (!video) return
        video.muted = true
        video.playsInline = true
        const playPromise = video.play()
        if (playPromise?.catch) {
          playPromise.catch(() => {
            if (interactionHandler) return
            interactionHandler = () => {
              landingVideoRefs.current.forEach((vid) => {
                if (vid) {
                  vid.play().catch(() => {})
                }
              })
            }
            window.addEventListener('pointerdown', interactionHandler, { once: true })
            window.addEventListener('keydown', interactionHandler, { once: true })
          })
        }
      })
    }

    playAllVideos()

    return () => {
      if (interactionHandler) {
        window.removeEventListener('pointerdown', interactionHandler)
        window.removeEventListener('keydown', interactionHandler)
      }
    }
  }, [showTypingPad])

  useEffect(() => {
    const phrasesCount = LANDING_TYPING_PHRASES.length
    if (phrasesCount === 0) {
      return
    }
    const activePhrase =
      LANDING_TYPING_PHRASES[landingTypingIndex % phrasesCount] || ''
    let timeoutId

    if (!isDeletingLandingText && landingTypingText === activePhrase) {
      timeoutId = setTimeout(() => setIsDeletingLandingText(true), 1500)
    } else if (isDeletingLandingText && landingTypingText === '') {
      timeoutId = setTimeout(() => {
        setIsDeletingLandingText(false)
        setLandingTypingIndex((prev) => (prev + 1) % phrasesCount)
      }, 300)
    } else {
      const nextLength =
        landingTypingText.length + (isDeletingLandingText ? -1 : 1)
      timeoutId = setTimeout(() => {
        setLandingTypingText(activePhrase.slice(0, Math.max(0, nextLength)))
      }, isDeletingLandingText ? 45 : 120)
    }

    return () => clearTimeout(timeoutId)
  }, [landingTypingIndex, landingTypingText, isDeletingLandingText])

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
      // Parse content into blocks when syncing
      if (nextValue) {
        const blocks = nextValue.split('\n\n---\n\n').filter(b => b.trim() !== '')
        if (blocks.length > 0) {
          setCodeBlocks(blocks.map((block, idx) => ({ 
            id: idx, 
            content: block.trim(),
            name: `Block ${idx + 1}`
          })))
        } else {
          setCodeBlocks([{ id: 0, content: nextValue, name: 'Block 1' }])
        }
      } else {
        setCodeBlocks([{ id: 0, content: '', name: 'Block 1' }])
      }
    }
    const handleTyping = (flag) => setRemoteTyping(Boolean(flag))
    const handleJoinSuccess = (code) => {
      clearCreateSessionFallback()
      setIsOfflineSession(false)
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
      console.log('user:joined event received:', data)
      // Only show typing pad when BOTH users are connected (roomSize >= 2)
      if (data && data.roomSize && data.roomSize >= 2 && data.showPad) {
        console.log('Both users connected! Showing typing pad, roomSize:', data.roomSize)
        clearCreateSessionFallback()
        setIsOfflineSession(false)
        setShowTypingPad(true)
        closeShareDropdown()
        setStatus('Connected')
        if (data.participants) {
          updateParticipants(data.participants)
        }
        // Also ensure connection code is set if not already
        if (data.code) {
          setConnectionCode((prevCode) => {
            const newCode = prevCode || data.code
            console.log('Setting connection code:', newCode)
            return newCode
          })
        }
      }
    }
    const handleSessionCreated = (data) => {
      console.log('session:created event received:', data)
      // Creator ko code dikhao but typing pad nahi (wait for user to join)
      if (data && data.code) {
        clearCreateSessionFallback()
        setIsOfflineSession(false)
        setConnectionCode(data.code)
        setInputCode(data.code)
        setStatus('Waiting for user to join...')
        saveSessionMetadata(data.code, 'creator')
        if (data.participants) {
          updateParticipants(data.participants)
        }
        // Don't show typing pad yet - wait for both users
      }
    }
    const handleWaitingForUser = (data) => {
      console.log('waiting:for:user event received:', data)
      // User joined but only one user, so don't show pad yet
      if (data && data.code) {
        clearCreateSessionFallback()
        setIsOfflineSession(false)
        setConnectionCode(data.code)
        setInputCode(data.code)
        setStatus('Waiting for another user...')
        if (data.participants) {
          updateParticipants(data.participants)
        }
      }
    }
    const handleParticipantsUpdate = (payload) => {
      updateParticipants(payload?.participants)
    }
    const handleSelfInfo = (payload) => {
      if (payload?.name) {
        setDisplayName(payload.name)
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
    client.on('session:created', handleSessionCreated)
    client.on('waiting:for:user', handleWaitingForUser)
    client.on('participants:update', handleParticipantsUpdate)
    client.on('self:info', handleSelfInfo)

    return () => {
      client.off('connect', handleConnect)
      client.off('disconnect', handleDisconnect)
      client.off('content:sync', handleSync)
      client.off('typing', handleTyping)
      client.off('join:success', handleJoinSuccess)
      client.off('join:error', handleJoinError)
      client.off('code:config', handleCodeConfig)
      client.off('user:joined', handleUserJoined)
      client.off('session:created', handleSessionCreated)
      client.off('waiting:for:user', handleWaitingForUser)
      client.off('participants:update', handleParticipantsUpdate)
      client.off('self:info', handleSelfInfo)
    }
  }, [updateParticipants, openShareDropdown, closeShareDropdown, clearCreateSessionFallback])

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }
      clearCreateSessionFallback()
      clearOfflineRetryTimer()
      // Cleanup recording on unmount
      if (mediaRecorderRef.current && isRecording) {
        mediaRecorderRef.current.stop()
        setIsRecording(false)
      }
    }
  }, [clearCreateSessionFallback, clearOfflineRetryTimer, isRecording])

  useEffect(() => {
    saveDisplayName(displayName || '')
    const client = getSocket()
    client.auth = {
      ...(client.auth || {}),
      clientId: clientIdRef.current,
      name: displayName || '',
    }
  }, [displayName])
  
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

  const joinSessionWithCode = useCallback(
    (
      rawCode,
      {
        persistRole = 'guest',
        showPadOnJoin = true,
        statusMessage = 'Joining session...',
        silent = false,
      } = {}
    ) => {
      const normalized = (rawCode || '').toUpperCase().trim()
      if (normalized.length !== codeLength) {
        if (!silent) {
          setStatus(`Connection code must be ${codeLength} characters`)
        }
        return
      }

      const client = getSocket()
      client.auth = {
        ...(client.auth || {}),
        clientId: clientIdRef.current,
        name: displayName || '',
      }

      if (!silent) {
        setStatus(statusMessage)
      }

      const handleJoinComplete = (joinedCode) => {
        setConnectionCode(joinedCode)
        if (showPadOnJoin) {
          setShowTypingPad(true)
          closeShareDropdown()
        }
        setStatus('Connected')
        saveSessionMetadata(joinedCode, persistRole)
        client.off('join:success', handleJoinComplete)
      }

      client.once('join:success', handleJoinComplete)

      const emitJoin = () => client.emit('join:session', normalized)
      if (client.connected) {
        emitJoin()
      } else {
        client.connect()
        client.once('connect', emitJoin)
      }
    },
    [codeLength, closeShareDropdown, displayName]
  )

  useEffect(() => {
    const saved = initialSession
    if (saved?.code) {
      const timer = setTimeout(() => {
        joinSessionWithCode(saved.code, {
          persistRole: saved.role || 'guest',
          showPadOnJoin: saved.role !== 'creator',
          statusMessage: 'Reconnecting…',
        })
      }, 0)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [initialSession, joinSessionWithCode])

  const handleNameSave = () => {
    const baseValue = pendingName !== '' ? pendingName : displayName
    const trimmed = (baseValue || '').trim()
    if (!trimmed) {
      setStatus('Name cannot be empty')
      return
    }
    if (trimmed.length < 2) {
      setStatus('Name must be at least 2 characters')
      return
    }
    if (trimmed === displayName) {
      setPendingName('')
      return
    }
    setIsSavingName(true)
    const client = getSocket()
    client.emit('user:updateName', trimmed, (response) => {
      setIsSavingName(false)
      if (response?.ok) {
        setDisplayName(response.name || trimmed)
        saveDisplayName(response.name || trimmed)
        setPendingName('')
        setStatus('Name updated')
      } else {
        setStatus(response?.error || 'Unable to update name')
      }
    })
  }

  const handleNameInputKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      handleNameSave()
    }
  }

  const handleAddNewBlock = () => {
    const newBlock = { id: codeBlocks.length, content: '', name: `Block ${codeBlocks.length + 1}` }
    setCodeBlocks([...codeBlocks, newBlock])
  }

  const handleBlockChange = (blockId, newContent) => {
    const updated = codeBlocks.map(block => 
      block.id === blockId ? { ...block, content: newContent } : block
    )
    setCodeBlocks(updated)
    
    // Update main content by joining all blocks
    const allContent = updated.map(b => b.content).join('\n\n---\n\n')
    setContent(allContent)
    getSocket().emit('content:update', allContent)
    notifyTyping()
  }

  const handleCopyBlock = (blockContent) => {
    navigator.clipboard.writeText(blockContent)
    setStatus('Block copied!')
    setTimeout(() => setStatus('Connected'), 2000)
  }

  const handleDeleteBlock = (blockId) => {
    if (codeBlocks.length > 1) {
      const updated = codeBlocks.filter(block => block.id !== blockId)
      // Reassign IDs and names
      const reindexed = updated.map((block, idx) => ({ ...block, id: idx, name: `Block ${idx + 1}` }))
      setCodeBlocks(reindexed)
      
      // Update main content
      const allContent = reindexed.map(b => b.content).join('\n\n---\n\n')
      setContent(allContent)
      getSocket().emit('content:update', allContent)
    }
  }

  const handleRenameBlock = (blockId, newName) => {
    const updated = codeBlocks.map(block => 
      block.id === blockId ? { ...block, name: newName || `Block ${blockId + 1}` } : block
    )
    setCodeBlocks(updated)
  }

  const convertAudioToBase64 = async (audioBlob) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64String = reader.result.split(',')[1]
        resolve(base64String)
      }
      reader.onerror = reject
      reader.readAsDataURL(audioBlob)
    })
  }

  const transcribeAudio = async (audioBlob) => {
    try {
      setIsTranscribing(true)
      setStatus('Transcribing audio...')
      
      const audioBase64 = await convertAudioToBase64(audioBlob)
      
      const response = await fetch(`${SOCKET_URL.replace('/socket.io', '')}/api/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio_b64: audioBase64,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Transcription failed')
      }

      const result = await response.json()
      
      // Format the transcription result
      let transcribedText = ''
      if (Array.isArray(result)) {
        // If result is array of chunks, combine them
        transcribedText = result.map(chunk => chunk.text || chunk).join(' ')
      } else if (result.text) {
        transcribedText = result.text
      } else if (typeof result === 'string') {
        transcribedText = result
      } else {
        // Try to extract text from chunks
        transcribedText = result.chunks?.map(chunk => chunk.text).join(' ') || JSON.stringify(result)
      }

      // Insert transcribed text into the active block
      if (transcribedText.trim()) {
        const activeBlock = codeBlocks.find(b => b.id === activeBlockId) || codeBlocks[0]
        const currentContent = activeBlock.content
        const newContent = currentContent 
          ? `${currentContent}\n${transcribedText}` 
          : transcribedText
        
        handleBlockChange(activeBlockId, newContent)
        setStatus('Transcription complete!')
        setTimeout(() => setStatus('Connected'), 2000)
      } else {
        setStatus('No text transcribed')
        setTimeout(() => setStatus('Connected'), 2000)
      }
    } catch (error) {
      console.error('Transcription error:', error)
      setStatus(`Transcription error: ${error.message}`)
      setTimeout(() => setStatus('Connected'), 3000)
    } finally {
      setIsTranscribing(false)
    }
  }

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      })
      
      audioChunksRef.current = []
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }
      
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        stream.getTracks().forEach(track => track.stop())
        await transcribeAudio(audioBlob)
      }
      
      mediaRecorderRef.current = mediaRecorder
      mediaRecorder.start()
      setIsRecording(true)
      setStatus('Recording... Click again to stop')
    } catch (error) {
      console.error('Error starting recording:', error)
      setStatus('Error: Could not access microphone')
      setTimeout(() => setStatus('Connected'), 3000)
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      setStatus('Processing audio...')
    }
  }

  const handleToggleRecording = () => {
    if (isRecording) {
      stopRecording()
    } else {
      startRecording()
    }
  }

  const handleCreateSession = useCallback(
    (options = {}) => {
      const { silentRetry = false } = options
      const client = getSocket()
      if (!silentRetry) {
        setIsOfflineSession(false)
        setStatus('Creating session...')
      }
      clearCreateSessionFallback()
      
      // Handler to receive the connection code
      const handleSessionCreated = (code) => {
        clearCreateSessionFallback()
        setIsOfflineSession(false)
        if (code) {
          setConnectionCode(code)
          setInputCode(code)
          setStatus('Waiting for another user...')
          setShowTypingPad(false)
          closeShareDropdown()
        }
        // Remove this one-time listener
        client.off('join:success', handleSessionCreated)
      }
      
      // Set up listener for the response
      client.once('join:success', handleSessionCreated)

      createSessionFallbackRef.current = setTimeout(() => {
        if (!silentRetry) {
          activateOfflineSession()
        }
        client.off('join:success', handleSessionCreated)
        createSessionFallbackRef.current = null
      }, silentRetry ? 2000 : 3000)
      
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
    },
    [activateOfflineSession, clearCreateSessionFallback, closeShareDropdown]
  )

  const handleRefreshConnectionCode = () => {
    const client = getSocket()
    if (isOfflineSession) {
      handleCreateSession()
      return
    }
    if (!connectionCode) {
      handleCreateSession()
      return
    }
    setStatus('Refreshing code...')
    closeShareDropdown()
    setShowTypingPad(false)
    setConnectedUsers([])
    setConnectionCode('')
    setInputCode('')
    clearSessionMetadata()
    client.emit('leave:session')
    setTimeout(() => {
      handleCreateSession()
    }, 200)
  }

  const handleJoinSession = () => {
    if (isOfflineSession) {
      setStatus('Server offline. Please wait for it to reconnect before joining.')
      return
    }
    joinSessionWithCode(inputCode, {
      persistRole: 'guest',
      showPadOnJoin: true,
      statusMessage: 'Joining session...',
    })
  }

  const handleCopyCode = () => {
    navigator.clipboard.writeText(connectionCode)
    setStatus('Code copied!')
    setTimeout(() => setStatus('Connected'), 2000)
  }

  useEffect(() => {
    if (!isOfflineSession) {
      clearOfflineRetryTimer()
      return
    }
    const attemptServerSession = () => {
      handleCreateSession({ silentRetry: true })
    }
    attemptServerSession()
    offlineRetryIntervalRef.current = setInterval(attemptServerSession, 2000)
    return () => {
      clearOfflineRetryTimer()
    }
  }, [isOfflineSession, handleCreateSession, clearOfflineRetryTimer])


  const handleBack = () => {
    const client = getSocket()
    // Leave current session
    if (connectionCode) {
      client.emit('leave:session')
    }
    // Reset state
    setIsOfflineSession(false)
    clearCreateSessionFallback()
    clearOfflineRetryTimer()
    setConnectionCode('')
    setInputCode('')
    setContent('')
    setCodeBlocks([{ id: 0, content: '', name: 'Block 1' }])
    setShowTypingPad(false)
    closeShareDropdown()
    setConnectedUsers([])
    clearSessionMetadata()
    setStatus('Connected')
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        showShareDropdown &&
        shareDropdownRef.current &&
        !shareDropdownRef.current.contains(event.target)
      ) {
        closeShareDropdown()
      }
    }

    if (showShareDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showShareDropdown, closeShareDropdown])

  const formatSocketId = (id) => {
    if (!id) return ''
    const safeId = String(id)
    return safeId.length > 10 ? `${safeId.slice(0, 4)}…${safeId.slice(-4)}` : safeId
  }

  const nameInputValue =
    pendingName !== '' ? pendingName : displayName || ''
  const canSaveName =
    nameInputValue.trim().length >= 2 &&
    nameInputValue.trim() !== displayName
  const isSaveDisabled = isSavingName || !canSaveName
  const handleDisconnectClick = () => {
    if (!connectionCode || isDisconnecting) return
    setIsDisconnecting(true)
    handleBack()
    setIsDisconnecting(false)
  }

  const highlightCode = useCallback((code) => {
    try {
      if (code.includes('function') || code.includes('const') || code.includes('let') || code.includes('var') || code.includes('=>')) {
        return highlight(code, languages.javascript, 'javascript')
      }
      if (code.trim().startsWith('{') || code.trim().startsWith('[')) {
        try {
          JSON.parse(code)
          return highlight(code, languages.json, 'json')
        } catch {
          // fall through
        }
      }
      if (code.includes('{') && code.includes(':') && code.includes(';')) {
        return highlight(code, languages.css, 'css')
      }
      if (code.includes('#') || code.includes('*') || (code.includes('[') && code.includes(']('))) {
        return highlight(code, languages.markdown, 'markdown')
      }
      if (code.includes('<') && code.includes('>')) {
        return highlight(code, languages.markup, 'markup')
      }
      return highlight(code, languages.javascript, 'javascript')
    } catch {
      return highlight(code, languages.plaintext, 'plaintext')
    }
  }, [])

  const renderPadHeader = () => (
    <header className="pad-header">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <p className="eyebrow">Shared paste pad</p>
          <h1>Instant Text Sharing</h1>
        </div>
        
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {showTypingPad && (
          <button
            className={`btn-voice ${isRecording ? 'btn-voice--recording' : ''} ${isTranscribing ? 'btn-voice--transcribing' : ''}`}
            onClick={handleToggleRecording}
            disabled={isTranscribing}
            title={isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing...' : 'Start voice recording'}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: 'none',
              background: isRecording ? '#ff4444' : isTranscribing ? '#ffaa00' : '#4CAF50',
              color: 'white',
              cursor: isTranscribing ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '14px',
              fontWeight: '500',
              transition: 'all 0.2s',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isRecording ? (
                <rect x="6" y="6" width="12" height="12" rx="2"></rect>
              ) : isTranscribing ? (
                <>
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </>
              ) : (
                <>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                  <line x1="12" y1="19" x2="12" y2="23"></line>
                  <line x1="8" y1="23" x2="16" y2="23"></line>
                </>
              )}
            </svg>
            {isRecording ? 'Stop' : isTranscribing ? 'Transcribing...' : 'Voice'}
          </button>
        )}
        <span className={`status-pill status-pill--${status === 'Connected' ? 'ok' : 'warn'}`}>
          {status}
        </span>
      </div>
    </header>
  )

  const renderConnectionPanel = () => {
    const isHostingSession = Boolean(connectionCode && !showTypingPad)

    return (
      <div className="connection-section">
        <p className="subtitle">
          {isHostingSession
            ? isOfflineSession
              ? 'Server connection is down. Share this temporary code or try refreshing once the socket is back.'
              : 'Share this connection code with your collaborator while we wait for them to join.'
            : 'Create a new session or join an existing one using a connection code.'}
        </p>
        <div className="connection-actions">
          {!connectionCode && (
            <button className="btn btn-primary" onClick={handleCreateSession}>
              Create New Session
            </button>
          )}

          {isHostingSession && (
            <div className={`host-code-card ${isOfflineSession ? 'host-code-card--offline' : ''}`}>
              <div className="host-code-label">
                {isOfflineSession ? 'Offline session code' : 'Your connection code'}
              </div>
              <div className="host-code-value">{connectionCode}</div>
              <div className="host-code-status">
                {isOfflineSession
                  ? 'Socket server unreachable. Share this placeholder or refresh when ready.'
                  : 'Waiting for your collaborator to join.'}
              </div>
              <div className="host-code-actions">
                <button className="btn btn-secondary" onClick={handleCopyCode}>
                  Copy Code
                </button>
                <button className="btn btn-ghost" onClick={handleRefreshConnectionCode}>
                  {isOfflineSession ? 'Generate new code' : 'Refresh Code'}
                </button>
              </div>
            </div>
          )}

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

          <div className="join-iframe-wrapper">
            <h3 className="iframe-card-title"><span className="iframe-card-title-text">Live AI Assistant</span></h3>
            <iframe
              src="https://lab.anam.ai/frame/ggbkkgGJB9tAxVb-vuCgN"
              width="100%"
              height="200"
              allow="microphone"
              title="AI Agent Assistant"
              style={{
                border: 'none',
                borderRadius: '16px',
                width: '100%',
                minHeight: '200px',
                boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
                marginTop: '1px',
              }}
            />
            
          </div>
        </div>
       
      </div>
      
    )
  }

  const renderTypingPanel = () => (
    <>
      <div className="code-blocks-container">
        {codeBlocks.map((block, index) => (
          <div key={block.id} className="code-block-wrapper">
            <div className="code-block-header">
              <input
                type="text"
                className="code-block-name-input"
                value={block.name}
                onChange={(e) => handleRenameBlock(block.id, e.target.value)}
                onBlur={(e) => {
                  if (!e.target.value.trim()) {
                    handleRenameBlock(block.id, `Block ${block.id + 1}`)
                  }
                }}
                placeholder={`Block ${index + 1}`}
              />
              <div className="code-block-actions">
                <button 
                  className="btn-copy-block" 
                  onClick={() => handleCopyBlock(block.content)}
                  title="Copy this block"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
                {codeBlocks.length > 1 && (
                  <button 
                    className="btn-delete-block" 
                    onClick={() => handleDeleteBlock(block.id)}
                    title="Delete this block"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                )}
              </div>
            </div>
            <div className="code-block-content">
              <Editor
                value={block.content}
                onValueChange={(code) => handleBlockChange(block.id, code)}
                onFocus={() => setActiveBlockId(block.id)}
                highlight={highlightCode}
                padding={16}
                className="code-editor-block"
                placeholder={`Start typing in Block ${index + 1}...`}
                style={{
                  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace",
                  fontSize: '1.05rem',
                  lineHeight: '1.6',
                  outline: 'none',
                }}
              />
            </div>
          </div>
        ))}
        
        <button className="btn-add-block" onClick={handleAddNewBlock}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Add New Block
        </button>
      </div>

      <footer className="pad-footer">
        <span>{content.length} characters</span>
        <span className={`typing-indicator ${remoteTyping ? 'typing-indicator--active' : ''}`}>
          {remoteTyping ? 'Someone is typing…' : 'Waiting for collaborators'}
        </span>
      </footer>
    </>
  )

  const renderVideoOverlay = (label) => (
    <div className="video-overlay" aria-live="polite">
      {label && <span className="video-overlay-label">{label}</span>}
      <span className="video-overlay-typing">
        {landingTypingText}
        <span className="video-overlay-cursor" aria-hidden="true" />
      </span>
    </div>
  )

  const renderLandingMedia = () => (
    <div className="landing-media">
      <div className="video-card video-card--primary">
        <img
          className="landing-video"
          src="/vite2.png"
          alt="Host View"
        />
        {renderVideoOverlay('Live typing')}
        <div className="video-badge">Host View</div>
      </div>

      <div className="video-connector">
        <svg
          className="video-connector-svg"
          viewBox="0 0 260 180"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          preserveAspectRatio="none"
        >
          <path className="video-connector-path" d="M10 120 L200 120 L200 170" />
          <path className="video-connector-arrow" d="M188 150 L200 178 L212 150" />
         
        </svg>
        <span className="connector-label">Connected</span>
      </div>

      <div className="video-card video-card--secondary">
        <img
          className="landing-video"
          src="/vite2.png"
          
        />
        {renderVideoOverlay('Guest preview')}
        <div className="video-badge">Guest View</div>
      </div>
    
    </div>
  )
  

  return (
    <main className="app-shell">
      {connectionCode && showTypingPad && (
        <div className="share-button-container" ref={shareDropdownRef}>
          <button 
            className="btn-share" 
            onClick={() => (showShareDropdown ? closeShareDropdown() : openShareDropdown())}
            title="Share connection code"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3"></circle>
              <circle cx="6" cy="12" r="3"></circle>
              <circle cx="18" cy="19" r="3"></circle>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
            </svg>
            Share
          </button>
          {showShareDropdown && (
            <div className="share-dropdown">
              <div className="share-name-editor">
                <div className="share-name-label">
                  <span>Your name</span>
                  <span className="share-name-hint">Visible to others</span>
                </div>
                <div className="share-name-input">
                  <input
                    type="text"
                    value={nameInputValue}
                    onChange={(e) => setPendingName(e.target.value)}
                    onKeyDown={handleNameInputKeyDown}
                    placeholder="Enter your name"
                  />
                  <button
                    className="btn-save-name"
                    onClick={handleNameSave}
                    disabled={isSaveDisabled}
                  >
                    {isSavingName ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
              <div className="share-connections">
                <div className="share-connections-header">
                  <span>Connected people</span>
                  <span className="share-connections-count">
                    {connectedUsers.length}
                  </span>
                </div>
                <div className="participant-list">
                  {connectedUsers.length > 0 ? (
                    connectedUsers.map((user, index) => {
                      const socketId = user?.socketId
                      const clientId = user?.clientId
                      const isSelf = clientId && clientId === clientIdValue
                      const fallbackLabel = `User ${index + 1}`
                      const displayLabel = user?.name || fallbackLabel
                      return (
                        <div
                          key={clientId || socketId || `${fallbackLabel}-${index}`}
                          className={`participant-pill ${isSelf ? 'participant-pill--self' : ''}`}
                        >
                          <div className="participant-name">
                            {displayLabel}
                            {isSelf && <span className="participant-self-tag">You</span>}
                          </div>
                          <span className="participant-id">
                            {formatSocketId(socketId || clientId)}
                          </span>
                        </div>
                      )
                    })
                  ) : (
                    <div className="participant-pill participant-pill--empty">
                      Only you are here right now
                    </div>
                  )}
                </div>
              </div>
              <div className="share-divider" />
              <div className="share-code-wrapper">
                <div className="share-code-label">Connection Code</div>
                <div className="code-display">
                  <span className="code-value">{connectionCode}</span>
                  <button className="btn btn-copy" onClick={handleCopyCode}>
                    Copy
                  </button>
                </div>
              </div>
              <div className="share-actions">
                <button
                  className="btn-disconnect"
                  onClick={handleDisconnectClick}
                  disabled={isDisconnecting}
                >
                  {isDisconnecting ? 'Disconnecting…' : 'Disconnect Session'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showTypingPad && (
        <button className="btn-back-arrow-top-right" onClick={handleBack} title="Back to Create/Join Session">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
      )}

      {!showTypingPad ? (
        <div className="landing-shell">
          <section className="pad-card">
            {renderPadHeader()}
            {renderConnectionPanel()}
          </section>
          {renderLandingMedia()}
        </div>
      ) : (
        <section className="pad-card">
          {renderPadHeader()}
          {renderTypingPanel()}
        </section>
      )}
    </main>
  )
}

export default App
