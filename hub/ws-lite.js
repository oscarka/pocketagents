import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_MAX_PAYLOAD = 4 * 1024 * 1024

export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

function computeAcceptKey(secKey = '') {
  return createHash('sha1').update(`${String(secKey || '').trim()}${WS_GUID}`).digest('base64')
}

function encodeWsFrame(opcode, payloadBuf, { mask = false } = {}) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || '')
  const len = payload.length
  let headerLen = 2
  if (len >= 126 && len <= 65535) headerLen += 2
  else if (len > 65535) headerLen += 8
  if (mask) headerLen += 4

  const frame = Buffer.allocUnsafe(headerLen + len)
  frame[0] = 0x80 | (opcode & 0x0f) // FIN=1

  let offset = 2
  const maskBit = mask ? 0x80 : 0x00
  if (len < 126) {
    frame[1] = maskBit | len
  } else if (len <= 65535) {
    frame[1] = maskBit | 126
    frame.writeUInt16BE(len, 2)
    offset = 4
  } else {
    frame[1] = maskBit | 127
    frame.writeBigUInt64BE(BigInt(len), 2)
    offset = 10
  }

  if (mask) {
    const maskKey = randomBytes(4)
    maskKey.copy(frame, offset)
    offset += 4
    for (let i = 0; i < len; i += 1) {
      frame[offset + i] = payload[i] ^ maskKey[i & 3]
    }
  } else if (len > 0) {
    payload.copy(frame, offset)
  }
  return frame
}

export class LiteWebSocket extends EventEmitter {
  constructor(socket, { isClient = false, maxPayloadBytes = DEFAULT_MAX_PAYLOAD, initialHead = null } = {}) {
    super()
    this.socket = socket
    this.isClient = Boolean(isClient)
    this.maxPayloadBytes = Math.max(64 * 1024, Number(maxPayloadBytes) || DEFAULT_MAX_PAYLOAD)
    this.readyState = WS_OPEN
    this._buf = Buffer.alloc(0)
    this._fragOpcode = 0
    this._fragChunks = []
    this._fragSize = 0
    this._closedEmitted = false

    try {
      this.socket.setNoDelay?.(true)
      this.socket.setKeepAlive?.(true, 15_000)
    } catch { }

    this.socket.on('data', chunk => this._onData(chunk))
    this.socket.on('error', err => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err)
      }
      this._finishClose(1006, err?.message || 'socket_error')
    })
    this.socket.on('close', () => {
      this._finishClose(1006, '')
    })
    this.socket.on('end', () => {
      this._finishClose(1000, '')
    })

    if (initialHead && initialHead.length > 0) {
      queueMicrotask(() => {
        if (this.readyState !== WS_CLOSED) {
          this._onData(initialHead)
        }
      })
    }
  }

  sendText(text = '') {
    if (this.readyState !== WS_OPEN || this.socket.destroyed) return false
    const frame = encodeWsFrame(0x1, Buffer.from(String(text ?? ''), 'utf8'), { mask: this.isClient })
    try {
      this.socket.write(frame)
      return true
    } catch {
      return false
    }
  }

  sendJson(obj) {
    return this.sendText(JSON.stringify(obj))
  }

  sendBinary(buf) {
    if (this.readyState !== WS_OPEN || this.socket.destroyed) return false
    const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
    const frame = encodeWsFrame(0x2, raw, { mask: this.isClient })
    try {
      this.socket.write(frame)
      return true
    } catch {
      return false
    }
  }

  ping(payload = '') {
    if (this.readyState !== WS_OPEN || this.socket.destroyed) return false
    const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8')
    const frame = encodeWsFrame(0x9, raw.subarray(0, 125), { mask: this.isClient })
    try {
      this.socket.write(frame)
      return true
    } catch {
      return false
    }
  }

  pong(payload = Buffer.alloc(0)) {
    if (this.readyState !== WS_OPEN || this.socket.destroyed) return false
    const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || [])
    const frame = encodeWsFrame(0xA, raw.subarray(0, 125), { mask: this.isClient })
    try {
      this.socket.write(frame)
      return true
    } catch {
      return false
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === WS_CLOSED) return
    const wasOpen = this.readyState === WS_OPEN
    this.readyState = WS_CLOSING
    if (wasOpen && !this.socket.destroyed) {
      const reasonBuf = Buffer.from(String(reason || ''), 'utf8').subarray(0, 120)
      const body = Buffer.allocUnsafe(2 + reasonBuf.length)
      body.writeUInt16BE(Number(code) || 1000, 0)
      reasonBuf.copy(body, 2)
      const frame = encodeWsFrame(0x8, body, { mask: this.isClient })
      try {
        this.socket.write(frame)
      } catch { }
      try {
        this.socket.end()
      } catch { }
    }
    this._finishClose(code, reason)
  }

  terminate() {
    this.readyState = WS_CLOSED
    try {
      this.socket.destroy()
    } catch { }
    this._finishClose(1006, 'terminated')
  }

  _finishClose(code = 1000, reason = '') {
    if (this._closedEmitted) return
    this._closedEmitted = true
    this.readyState = WS_CLOSED
    this._buf = Buffer.alloc(0)
    this._fragChunks = []
    this._fragSize = 0
    this.emit('close', code, reason)
  }

  _onData(chunk) {
    if (this.readyState === WS_CLOSED || !chunk || chunk.length === 0) return
    this._buf = this._buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buf, chunk])

    while (this._buf.length >= 2) {
      const b0 = this._buf[0]
      const b1 = this._buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f
      let offset = 2

      if (payloadLen === 126) {
        if (this._buf.length < 4) return
        payloadLen = this._buf.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (this._buf.length < 10) return
        const bigLen = this._buf.readBigUInt64BE(2)
        if (bigLen > BigInt(this.maxPayloadBytes)) {
          this.close(1009, 'payload_too_large')
          return
        }
        payloadLen = Number(bigLen)
        offset = 10
      }

      if (payloadLen > this.maxPayloadBytes) {
        this.close(1009, 'payload_too_large')
        return
      }

      const maskLen = masked ? 4 : 0
      const totalLen = offset + maskLen + payloadLen
      if (this._buf.length < totalLen) return

      let payload
      if (masked) {
        const maskKey = this._buf.subarray(offset, offset + 4)
        const raw = this._buf.subarray(offset + 4, totalLen)
        payload = Buffer.allocUnsafe(payloadLen)
        for (let i = 0; i < payloadLen; i += 1) {
          payload[i] = raw[i] ^ maskKey[i & 3]
        }
      } else {
        payload = Buffer.from(this._buf.subarray(offset, totalLen))
      }

      this._buf = totalLen === this._buf.length ? Buffer.alloc(0) : this._buf.subarray(totalLen)

      // Control frames (can arrive interleaved inside fragmented messages)
      if (opcode === 0x8) {
        let closeCode = 1000
        let closeReason = ''
        if (payload.length >= 2) {
          closeCode = payload.readUInt16BE(0)
          closeReason = payload.subarray(2).toString('utf8')
        }
        if (this.readyState === WS_OPEN) {
          this.close(closeCode, closeReason)
        } else {
          this._finishClose(closeCode, closeReason)
        }
        return
      }
      if (opcode === 0x9) {
        this.pong(payload)
        this.emit('ping', payload)
        continue
      }
      if (opcode === 0xA) {
        this.emit('pong', payload)
        continue
      }

      // Data frames (text=0x1, binary=0x2, continuation=0x0)
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this._emitDataMessage(opcode, payload)
        } else {
          this._fragOpcode = opcode
          this._fragChunks = [payload]
          this._fragSize = payload.length
        }
      } else if (opcode === 0x0) {
        if (!this._fragOpcode) {
          this.close(1002, 'unexpected_continuation')
          return
        }
        this._fragSize += payload.length
        if (this._fragSize > this.maxPayloadBytes) {
          this.close(1009, 'fragmented_payload_too_large')
          return
        }
        this._fragChunks.push(payload)
        if (fin) {
          const assembled = Buffer.concat(this._fragChunks)
          const op = this._fragOpcode
          this._fragOpcode = 0
          this._fragChunks = []
          this._fragSize = 0
          this._emitDataMessage(op, assembled)
        }
      } else {
        this.close(1002, `unsupported_opcode_${opcode}`)
        return
      }
    }
  }

  _emitDataMessage(opcode, payload) {
    if (opcode === 0x1) {
      this.emit('message', payload.toString('utf8'), false)
    } else {
      this.emit('message', payload, true)
    }
  }
}

export function rejectUpgradeSocket(socket, statusCode = 401, message = 'Unauthorized') {
  try {
    const body = String(message || 'Unauthorized')
    const statusText = statusCode === 401 ? 'Unauthorized' : statusCode === 404 ? 'Not Found' : 'Bad Request'
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
      + body,
    )
    socket.destroy()
  } catch {
    try { socket.destroy() } catch { }
  }
}

export function acceptWebSocketUpgrade(req, socket, head = Buffer.alloc(0), opts = {}) {
  const secKey = String(req?.headers?.['sec-websocket-key'] || '').trim()
  const upgradeHdr = String(req?.headers?.upgrade || '').trim().toLowerCase()
  if (!secKey || upgradeHdr !== 'websocket') {
    rejectUpgradeSocket(socket, 400, 'Invalid WebSocket upgrade headers')
    return null
  }
  const acceptKey = computeAcceptKey(secKey)
  const respHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n')
  socket.write(respHeaders)
  return new LiteWebSocket(socket, {
    isClient: false,
    maxPayloadBytes: opts.maxPayloadBytes || DEFAULT_MAX_PAYLOAD,
    initialHead: head,
  })
}

export function connectWebSocket(rawUrl, { headers = {}, timeoutMs = 15_000, maxPayloadBytes = DEFAULT_MAX_PAYLOAD } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      reject(new Error(`Invalid WebSocket URL: ${rawUrl}`))
      return
    }
    const isSecure = parsed.protocol === 'wss:'
    if (!isSecure && parsed.protocol !== 'ws:') {
      reject(new Error(`Unsupported WebSocket protocol: ${parsed.protocol}`))
      return
    }

    const host = parsed.hostname
    const port = Number(parsed.port) || (isSecure ? 443 : 80)
    const hostHeader = parsed.port ? `${host}:${parsed.port}` : host
    const pathAndQuery = `${parsed.pathname || '/'}${parsed.search || ''}`
    const secKey = randomBytes(16).toString('base64')
    const expectedAccept = computeAcceptKey(secKey)

    let settled = false
    let socket = null
    let timer = null

    const fail = err => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { socket?.destroy() } catch { }
      reject(err instanceof Error ? err : new Error(String(err || 'WebSocket connection failed')))
    }

    timer = setTimeout(() => {
      fail(new Error(`WebSocket handshake timeout (${timeoutMs}ms)`))
    }, Math.max(1000, Number(timeoutMs) || 15_000))
    timer.unref?.()

    const onConnected = () => {
      const headerLines = [
        `GET ${pathAndQuery} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${secKey}`,
        'Sec-WebSocket-Version: 13',
      ]
      for (const [k, v] of Object.entries(headers || {})) {
        if (v === undefined || v === null || String(v).trim() === '') continue
        const cleanK = String(k).replace(/[\r\n:]/g, '')
        const cleanV = String(v).replace(/[\r\n]/g, '')
        if (cleanK) headerLines.push(`${cleanK}: ${cleanV}`)
      }
      headerLines.push('', '')
      socket.write(headerLines.join('\r\n'))
    }

    socket = isSecure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true }, onConnected)
      : net.connect({ host, port }, onConnected)

    let handshakeBuf = Buffer.alloc(0)

    const onHandshakeData = chunk => {
      handshakeBuf = Buffer.concat([handshakeBuf, chunk])
      const headerEnd = handshakeBuf.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        if (handshakeBuf.length > 32 * 1024) {
          fail(new Error('WebSocket handshake response headers too large'))
        }
        return
      }
      const headerText = handshakeBuf.subarray(0, headerEnd).toString('utf8')
      const leftover = handshakeBuf.subarray(headerEnd + 4)
      const lines = headerText.split('\r\n')
      const statusLine = lines[0] || ''
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b(.*)$/i.exec(statusLine)
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0
      const respHeaders = {}
      for (let i = 1; i < lines.length; i += 1) {
        const idx = lines[i].indexOf(':')
        if (idx > 0) {
          respHeaders[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim()
        }
      }

      if (statusCode !== 101) {
        const apiMsg = respHeaders['x-api-message'] || respHeaders['x-api-status-code'] || ''
        const bodySnippet = leftover.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 220)
        const detail = [apiMsg, bodySnippet].filter(Boolean).join(' · ')
        fail(new Error(`WebSocket upgrade failed HTTP ${statusCode || '?'}${detail ? `: ${detail}` : ''}`))
        return
      }
      if (respHeaders['sec-websocket-accept'] && respHeaders['sec-websocket-accept'] !== expectedAccept) {
        fail(new Error('Invalid Sec-WebSocket-Accept from server'))
        return
      }

      // Handshake succeeded — detach handshake listeners and transfer socket to LiteWebSocket
      socket.off('data', onHandshakeData)
      socket.off('error', onHandshakeError)
      socket.off('close', onHandshakeClose)
      if (timer) clearTimeout(timer)
      settled = true

      const ws = new LiteWebSocket(socket, {
        isClient: true,
        maxPayloadBytes,
        initialHead: leftover,
      })
      ws.responseHeaders = respHeaders
      resolve(ws)
    }

    const onHandshakeError = err => fail(err)
    const onHandshakeClose = () => fail(new Error('WebSocket closed before handshake completed'))

    socket.on('data', onHandshakeData)
    socket.on('error', onHandshakeError)
    socket.on('close', onHandshakeClose)
  })
}
