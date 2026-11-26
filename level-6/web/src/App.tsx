import { useEffect, useRef, useState, type FormEvent } from 'react'
import './App.css'

type StageStatus = 'pending' | 'running' | 'completed' | 'failed'

interface ScanResult {
  id: string
  domain: string
  status: 'queued' | 'scanning' | 'completed' | 'failed'
  currentStage: 'domain_scanning' | 'dns_checking' | null
  stages: {
    domain_scanning: StageStatus
    dns_checking: StageStatus
  }
  message: string
  total: number
  subdomains: string[]
  resolvedCount: number
  resolvedSubdomains: string[]
  error?: string
  createdAt: string
  completedAt?: string
}

interface InAppNotification {
  id: string
  title: string
  body: string
  type: 'info' | 'success' | 'error'
  domain?: string | null
  read: boolean
  createdAt: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'
const NOTIFICATION_URL = import.meta.env.VITE_NOTIFICATION_URL ?? 'http://localhost:3002'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

function stageLabel(status: StageStatus) {
  switch (status) {
    case 'running':
      return 'Scanning now...'
    case 'completed':
      return 'Done'
    case 'failed':
      return 'Failed'
    default:
      return 'Waiting'
  }
}

function App() {
  const [domain, setDomain] = useState('')
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  // In-app & Web Push notification state
  const [notifications, setNotifications] = useState<InAppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [showNotifs, setShowNotifs] = useState(false)
  const [pushStatus, setPushStatus] = useState<'idle' | 'enabled' | 'unsupported'>('idle')

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushStatus('unsupported')
    } else if (Notification.permission === 'granted') {
      setPushStatus('enabled')
    }

    // Load initial in-app notifications
    fetch(`${NOTIFICATION_URL}/notifications`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { items: InAppNotification[]; unreadCount: number } | null) => {
        if (data) {
          setNotifications(data.items)
          setUnreadCount(data.unreadCount)
        }
      })
      .catch(() => undefined)

    // Subscribe to live in-app notifications via SSE
    const notifEs = new EventSource(`${NOTIFICATION_URL}/notifications/stream`)
    notifEs.onmessage = (event) => {
      try {
        const item = JSON.parse(event.data) as InAppNotification
        setNotifications((prev) => [item, ...prev])
        setUnreadCount((prev) => prev + 1)
      } catch {
        // Ignore malformed payload
      }
    }

    return () => {
      notifEs.close()
      eventSourceRef.current?.close()
    }
  }, [])

  async function enablePushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushStatus('unsupported')
      return
    }

    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return

      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready

      const keyRes = await fetch(`${NOTIFICATION_URL}/notifications/vapid-public-key`)
      const { publicKey } = (await keyRes.json()) as { publicKey: string }

      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        })
      }

      await fetch(`${NOTIFICATION_URL}/notifications/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })

      setPushStatus('enabled')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable push notifications')
    }
  }

  async function markAllRead() {
    await fetch(`${NOTIFICATION_URL}/notifications/read-all`, { method: 'PATCH' }).catch(
      () => undefined,
    )
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnreadCount(0)
  }

  function connectSse(scanId: string) {
    eventSourceRef.current?.close()
    const es = new EventSource(`${API_URL}/scan/${scanId}/events`)
    eventSourceRef.current = es

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ScanResult
        setScan(data)
        if (data.status === 'completed' || data.status === 'failed') {
          setLoading(false)
          es.close()
        }
      } catch {
        // Ignore malformed SSE payload
      }
    }

    es.onerror = () => {
      es.close()
      setLoading(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = domain.trim()
    if (!trimmed) return

    eventSourceRef.current?.close()
    setError(null)
    setLoading(true)
    setScan(null)

    try {
      const res = await fetch(`${API_URL}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: trimmed }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.message ?? 'Failed to start scan')
      }

      const initialScan = data as ScanResult
      setScan(initialScan)
      connectSse(initialScan.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setLoading(false)
    }
  }

  const domainStage: StageStatus = scan?.stages.domain_scanning ?? 'pending'
  const dnsStage: StageStatus = scan?.stages.dns_checking ?? 'pending'
  const resolvedSet = new Set(scan?.resolvedSubdomains ?? [])

  return (
    <main className="scanner-container">
      <div className="top-bar">
        <button
          type="button"
          className="push-btn"
          onClick={enablePushNotifications}
          disabled={pushStatus !== 'idle'}
        >
          {pushStatus === 'enabled'
            ? 'Push Enabled'
            : pushStatus === 'unsupported'
              ? 'Push Unsupported'
              : 'Enable Push'}
        </button>

        <div className="notif-wrapper">
          <button
            type="button"
            className="bell-btn"
            onClick={() => setShowNotifs((v) => !v)}
          >
            Notifications {unreadCount > 0 && <span className="badge">{unreadCount}</span>}
          </button>

          {showNotifs && (
            <div className="notif-dropdown">
              <div className="notif-dropdown-header">
                <strong>In-App Notifications</strong>
                {unreadCount > 0 && (
                  <button type="button" className="link-btn" onClick={markAllRead}>
                    Mark all read
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <p className="notif-empty">No notifications yet.</p>
              ) : (
                <ul className="notif-list">
                  {notifications.map((n) => (
                    <li key={n.id} className={`notif-item ${n.read ? '' : 'notif-unread'}`}>
                      <div className="notif-title">{n.title}</div>
                      <div className="notif-body">{n.body}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <header className="scanner-header">
        <h1>Subdomain Scanner</h1>
        <p>Enter a domain name to run Subfinder &amp; DNS checking with live SSE updates.</p>
      </header>

      <form className="scanner-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="example.com"
          aria-label="Domain name"
          disabled={loading}
          required
        />
        <button type="submit" disabled={loading || !domain.trim()}>
          {loading ? 'Scanning...' : 'Scan'}
        </button>
      </form>

      {error && <div className="scanner-error">{error}</div>}

      <section className="pipeline">
        <div className={`stage-card stage-${domainStage}`}>
          <div className="stage-title">1. Domain Scanning</div>
          <div className="stage-sub">{stageLabel(domainStage)}</div>
        </div>

        <div className="pipeline-arrow" aria-hidden="true">
          &rarr;
        </div>

        <div className={`stage-card stage-${dnsStage}`}>
          <div className="stage-title">2. DNS Checking</div>
          <div className="stage-sub">{stageLabel(dnsStage)}</div>
        </div>
      </section>

      {scan?.message && <p className="live-message">{scan.message}</p>}

      <section className="scanner-results">
        <div className="stats-grid">
          <div className="total-card">
            <span className="total-label">Total Subdomains</span>
            <strong className="total-value">{scan ? scan.total : 0}</strong>
          </div>

          <div className="total-card">
            <span className="total-label">DNS Resolved</span>
            <strong className="total-value">{scan ? scan.resolvedCount : 0}</strong>
          </div>
        </div>

        {scan?.status === 'failed' && scan.error && (
          <div className="scanner-error">Scan failed: {scan.error}</div>
        )}

        {scan && scan.subdomains.length > 0 && (
          <div className="subdomain-list-wrap">
            <h2>Discovered Subdomains ({scan.total})</h2>
            <ul className="subdomain-list">
              {scan.subdomains.map((sub) => (
                <li key={sub} className="subdomain-item">
                  <span>{sub}</span>
                  {(dnsStage === 'running' || dnsStage === 'completed') &&
                    (resolvedSet.has(sub) ? (
                      <span className="dns-pill dns-live">DNS OK</span>
                    ) : dnsStage === 'completed' ? (
                      <span className="dns-pill dns-dead">No DNS</span>
                    ) : null)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  )
}

export default App
