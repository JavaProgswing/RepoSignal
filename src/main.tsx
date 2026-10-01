import React, { FormEvent, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity, AlertCircle, ArrowLeft, ArrowUpRight, Bot, Check, CheckCircle2,
  ChevronDown, CircleDot, Clock3, Code2, Copy, Eye, FileCode2, Filter,
  GitBranch, GitPullRequest, KeyRound, Link2, LoaderCircle, LockKeyhole,
  Network, RefreshCw, Search, ShieldCheck, Sparkles, Star, Zap,
} from 'lucide-react'
import './styles.css'

type Evidence = { label: string; value: string; tone: 'risk' | 'attention' | 'positive' | 'neutral' }
type Duplicate = { number: number; title: string; similarity: number; url: string }
type Item = {
  number: number
  kind: 'Issue' | 'Pull request'
  title: string
  author: string
  avatar?: string
  url: string
  created_at: string
  updated_at: string
  labels: string[]
  comments: number
  score: number
  confidence: number
  category: string
  action: string
  summary: string
  signals: string[]
  evidence: Evidence[]
  duplicate?: Duplicate
  draft_response: string
  files: string[]
  additions: number
  deletions: number
  draft: boolean
  estimated_minutes: number
  outcome: string
  why_now: string
  activity: {
    status: 'new' | 'changed' | 'unchanged'
    comments_delta: number
    score_delta: number
  }
}
type Analysis = {
  repository: {
    owner: string
    name: string
    full_name: string
    description?: string
    url: string
    stars: number
    forks: number
    open_issues: number
    default_branch: string
    avatar?: string
    private: boolean
  }
  items: Item[]
  policies: { name: string; path: string; url?: string; preview?: string }[]
  summary: {
    analyzed: number
    needs_attention: number
    ready: number
    duplicates: number
    issues: number
    pull_requests: number
    new_items: number
    changed_items: number
    previous_scan?: string
  }
  rate_limit: { remaining?: number; limit?: number }
  analyzed_at: string
}
type QueueFilter = 'attention' | 'all' | 'issues' | 'pulls' | 'duplicates' | 'ready'

function matchesQueueFilter(item: Item, filter: QueueFilter) {
  return filter === 'all' ||
    (filter === 'attention' && item.score >= 50) ||
    (filter === 'issues' && item.kind === 'Issue') ||
    (filter === 'pulls' && item.kind === 'Pull request') ||
    (filter === 'duplicates' && Boolean(item.duplicate)) ||
    (filter === 'ready' && item.category === 'Ready to review')
}

function buildFocusPlan(items: Item[], budget: number) {
  type Plan = { value: number; items: Item[] }
  const plans: Array<Plan | null> = Array.from({ length: budget + 1 }, () => null)
  plans[0] = { value: 0, items: [] }
  for (const item of items.filter((candidate) => !candidate.draft)) {
    const cost = Math.min(budget, Math.max(5, item.estimated_minutes))
    const value = item.score
      + (item.category === 'Ready to review' ? 18 : 0)
      + (item.activity.status === 'new' ? 12 : item.activity.status === 'changed' ? 8 : 0)
    for (let minute = budget; minute >= cost; minute -= 1) {
      const previous = plans[minute - cost]
      if (!previous) continue
      const candidate = { value: previous.value + value, items: [...previous.items, item] }
      if (!plans[minute] || candidate.value > plans[minute]!.value) plans[minute] = candidate
    }
  }
  return plans
    .filter((plan): plan is Plan => Boolean(plan))
    .sort((left, right) => right.value - left.value)[0]?.items
    .sort((left, right) => right.score - left.score) ?? []
}

function App() {
  const [repository, setRepository] = useState(() => localStorage.getItem('reposignal:last-repo') || '')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)
  const [filter, setFilter] = useState<QueueFilter>('attention')
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const [detailTab, setDetailTab] = useState<'evidence' | 'files'>('evidence')
  const [focusMinutes, setFocusMinutes] = useState(30)
  const [planCopied, setPlanCopied] = useState(false)

  const analyze = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!repository.trim()) {
      setError('Enter a GitHub repository such as owner/repository.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository: repository.trim(), token: token.trim() || null, max_items: 30 }),
      })
      const body = await response.text()
      let payload: unknown
      try {
        payload = body ? JSON.parse(body) : null
      } catch {
        throw new Error('The analysis service returned an invalid response. Please try again.')
      }
      if (!response.ok) {
        const detail = payload && typeof payload === 'object' && 'detail' in payload
          ? String(payload.detail)
          : `Analysis failed (${response.status}).`
        throw new Error(detail)
      }
      if (!payload) throw new Error('The analysis service is unavailable. Start RepoSignal with npm run dev and try again.')
      const result = payload as Analysis
      setAnalysis(result)
      localStorage.setItem('reposignal:last-repo', result.repository.full_name)
      setRepository(result.repository.full_name)
      setFilter(result.summary.needs_attention > 0 ? 'attention' : 'all')
      setSearch('')
      const first = result.items[0]
      setSelectedNumber(first?.number ?? null)
      setDraft(first?.draft_response ?? '')
      setDetailTab('evidence')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not analyze this repository.')
    } finally {
      setLoading(false)
    }
  }

  const selected = analysis?.items.find((item) => item.number === selectedNumber) ?? analysis?.items[0]
  const visibleItems = useMemo(() => {
    if (!analysis) return []
    return analysis.items.filter((item) => {
      const text = (item.title + ' ' + item.author + ' ' + item.number + ' ' + item.labels.join(' ')).toLowerCase()
      return matchesQueueFilter(item, filter) && text.includes(search.toLowerCase())
    })
  }, [analysis, filter, search])

  const focusPlan = useMemo(
    () => analysis ? buildFocusPlan(analysis.items, focusMinutes) : [],
    [analysis, focusMinutes],
  )
  const plannedMinutes = focusPlan.reduce((total, item) => total + item.estimated_minutes, 0)

  const chooseItem = (item: Item) => {
    setSelectedNumber(item.number)
    setDraft(item.draft_response)
    setDetailTab('evidence')
  }

  const copyDraft = async () => {
    await navigator.clipboard.writeText(draft)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  const copyPlan = async () => {
    if (!analysis) return
    const lines = [
      '# RepoSignal focus plan — ' + analysis.repository.full_name,
      '',
      ...focusPlan.map((item, index) =>
        (index + 1) + '. [' + item.kind + ' #' + item.number + '](' + item.url + ') — ' + item.action +
        ' (' + item.estimated_minutes + ' min)\n   ' + item.why_now
      ),
    ]
    await navigator.clipboard.writeText(lines.join('\n'))
    setPlanCopied(true)
    window.setTimeout(() => setPlanCopied(false), 1800)
  }

  const reset = () => {
    setAnalysis(null)
    setError('')
    setSelectedNumber(null)
  }

  return (
    <div className="app">
      <header className="site-header">
        <button className="wordmark" onClick={reset} aria-label="RepoSignal home">
          <span className="logo"><Activity size={19} strokeWidth={2.5}/></span>
          <span>RepoSignal</span>
        </button>
        <div className="header-note"><LockKeyhole size={14}/> Local analysis service</div>
        {analysis && <button className="subtle-button" onClick={reset}><ArrowLeft size={15}/> Change repository</button>}
      </header>

      {!analysis ? (
        <main className="landing">
          <section className="hero">
            <div className="hero-copy">
              <div className="overline"><span/> Built for maintainers, not metrics</div>
              <h1>Know what deserves your attention <em>right now.</em></h1>
              <p>Connect a GitHub repository. RepoSignal reads its live issues, pull requests, checks, changed files, and policies—then builds an evidence-backed priority queue.</p>
              <div className="trust-row">
                <span><Check size={15}/> No autonomous actions</span>
                <span><Check size={15}/> Public repos work without a token</span>
                <span><Check size={15}/> Local duplicate detection</span>
              </div>
            </div>

            <form className="connect-card" onSubmit={analyze}>
              <div className="connect-heading">
                <span className="connect-icon"><GitBranch size={20}/></span>
                <div><strong>Analyze a repository</strong><small>Live data from the GitHub API</small></div>
              </div>
              <label className="field-label" htmlFor="repository">GitHub repository</label>
              <div className="repo-input">
                <Code2 size={18}/>
                <input
                  id="repository"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="owner/repository or GitHub URL"
                  autoComplete="off"
                  disabled={loading}
                />
              </div>
              <button type="button" className="token-reveal" onClick={() => setShowToken(!showToken)}>
                <KeyRound size={14}/> {showToken ? 'Hide access token' : 'Private repo or higher rate limit?'} <ChevronDown size={14} className={showToken ? 'rotated' : ''}/>
              </button>
              {showToken && <div className="token-area">
                <label className="field-label" htmlFor="token">GitHub token</label>
                <input
                  id="token"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="github_pat_••••••••"
                  autoComplete="off"
                />
                <small>Sent only to GitHub for this analysis. RepoSignal does not store it.</small>
              </div>}
              {error && <div className="form-error"><AlertCircle size={16}/><span>{error}</span></div>}
              <button className="analyze-button" type="submit" disabled={loading}>
                {loading ? <><LoaderCircle className="spin" size={18}/> Reading live repository data…</> : <><Zap size={18}/> Build my attention queue</>}
              </button>
              <button className="example-button" type="button" disabled={loading} onClick={() => setRepository('fastapi/fastapi')}>
                Try with fastapi/fastapi
              </button>
            </form>
          </section>

          <section className="how-it-works">
            <div className="section-intro">
              <span>One clear workflow</span>
              <h2>From repository noise to a review plan.</h2>
            </div>
            <div className="steps">
              <Step number="01" icon={<Code2/>} title="Collect live facts" text="Open work, comments, reactions, changed files, CI checks, and repository policies."/>
              <Step number="02" icon={<Network/>} title="Find related work" text="Local TF-IDF similarity identifies likely duplicate issues and overlapping pull requests."/>
              <Step number="03" icon={<Sparkles/>} title="Explain the ranking" text="Every score is broken into visible evidence and a suggested next action for you to approve."/>
            </div>
          </section>
        </main>
      ) : (
        <main className="workspace">
          <section className="repo-header">
            <div className="repo-identity">
              {analysis.repository.avatar ? <img src={analysis.repository.avatar} alt="" /> : <span><Code2/></span>}
              <div>
                <div className="repo-name-line">
                  <h1>{analysis.repository.full_name}</h1>
                  <a href={analysis.repository.url} target="_blank" rel="noreferrer" aria-label="Open repository on GitHub"><ArrowUpRight size={17}/></a>
                </div>
                <p>{analysis.repository.description || 'No repository description provided.'}</p>
                <div className="repo-meta">
                  <span><Star size={13}/>{formatNumber(analysis.repository.stars)}</span>
                  <span><GitBranch size={13}/>{analysis.repository.default_branch}</span>
                  <span><Clock3 size={13}/>Analyzed {relativeTime(analysis.analyzed_at)}</span>
                  {analysis.rate_limit.remaining != null && <span>{analysis.rate_limit.remaining} API requests left</span>}
                </div>
              </div>
            </div>
            <button className="refresh-button" onClick={() => analyze()} disabled={loading}>
              <RefreshCw size={16} className={loading ? 'spin' : ''}/>{loading ? 'Refreshing…' : 'Refresh live data'}
            </button>
          </section>

          {error && <div className="workspace-error"><AlertCircle size={17}/>{error}<button onClick={() => setError('')}>Dismiss</button></div>}

          <section className="focus-plan">
            <div className="focus-main">
              <div className="focus-heading">
                <div>
                  <span className="focus-overline"><Sparkles size={14}/> Maintainer focus session</span>
                  <h2>Your next {focusMinutes} minutes</h2>
                  <p>A realistic set of actions chosen by attention, effort, readiness, and what changed since your last scan.</p>
                </div>
                <div className="time-options" aria-label="Focus session duration">
                  {[15, 30, 60].map((minutes) => <button key={minutes} className={focusMinutes === minutes ? 'active' : ''} onClick={() => setFocusMinutes(minutes)}>{minutes}m</button>)}
                </div>
              </div>
              <div className="focus-items">
                {focusPlan.length ? focusPlan.map((item, index) => <button key={item.kind + '-plan-' + item.number} onClick={() => chooseItem(item)}>
                  <span className="focus-rank">{index + 1}</span>
                  <span className={'type-icon ' + (item.kind === 'Issue' ? 'issue' : 'pull')}>{item.kind === 'Issue' ? <CircleDot size={16}/> : <GitPullRequest size={16}/>}</span>
                  <span className="focus-copy"><strong>{item.action}</strong><small>#{item.number} {item.title}</small><em>{item.outcome}</em></span>
                  <span className="effort"><Clock3 size={13}/>{item.estimated_minutes}m</span>
                </button>) : <div className="focus-empty">No open item fits this time budget.</div>}
              </div>
            </div>
            <aside className="focus-summary">
              <span className="scan-label">{analysis.summary.previous_scan ? 'Since your last scan' : 'First repository scan'}</span>
              <div className="delta-stats">
                <span><strong>{analysis.summary.new_items}</strong><small>new items</small></span>
                <span><strong>{analysis.summary.changed_items}</strong><small>changed</small></span>
              </div>
              <div className="plan-impact"><Zap size={17}/><span><strong>{focusPlan.length} actions · {plannedMinutes} minutes</strong><small>{focusPlan.map((item) => item.outcome).filter((value, index, values) => values.indexOf(value) === index).slice(0, 2).join(' · ') || 'Review open work'}</small></span></div>
              <button className="copy-plan" onClick={copyPlan}>{planCopied ? <CheckCircle2 size={15}/> : <Copy size={15}/>} {planCopied ? 'Plan copied' : 'Copy session plan'}</button>
            </aside>
          </section>

          <section className="summary-grid">
            <SummaryCard icon={<Zap/>} value={analysis.summary.needs_attention} label="Need attention" note="Score 50 or higher" tone="risk"/>
            <SummaryCard icon={<GitPullRequest/>} value={analysis.summary.pull_requests} label="Pull requests" note={analysis.summary.ready + ' ready to review'} tone="violet"/>
            <SummaryCard icon={<CircleDot/>} value={analysis.summary.issues} label="Issues" note={analysis.summary.analyzed + ' items analyzed'} tone="green"/>
            <SummaryCard icon={<Link2/>} value={analysis.summary.duplicates} label="Related items" note="Local semantic matches" tone="amber"/>
          </section>

          <section className="queue-layout">
            <div className="queue-column">
              <div className="queue-heading">
                <div><span className="live-dot"/><strong>Live attention queue</strong><small>{visibleItems.length} shown</small></div>
                <label className="search-box"><Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search work…"/></label>
              </div>
              <div className="filters" role="tablist" aria-label="Queue filters">
                {([
                  ['attention', 'Needs attention', analysis.summary.needs_attention],
                  ['all', 'All', analysis.summary.analyzed],
                  ['pulls', 'Pull requests', analysis.summary.pull_requests],
                  ['issues', 'Issues', analysis.summary.issues],
                  ['duplicates', 'Related', analysis.summary.duplicates],
                  ['ready', 'Ready', analysis.summary.ready],
                ] as [QueueFilter, string, number][]).map(([value, label, count]) => (
                  <button key={value} className={filter === value ? 'active' : ''} onClick={() => {
                    setFilter(value)
                    const firstMatch = analysis.items.find((item) => matchesQueueFilter(item, value))
                    if (firstMatch) chooseItem(firstMatch)
                  }} role="tab" aria-selected={filter === value}>
                    {label}<span>{count}</span>
                  </button>
                ))}
              </div>
              <div className="queue-items">
                {visibleItems.map((item, index) => (
                  <button key={item.kind + '-' + item.number} className={'work-item ' + (selected?.number === item.number ? 'selected' : '')} onClick={() => chooseItem(item)}>
                    <span className="position">{String(index + 1).padStart(2, '0')}</span>
                    <span className={'type-icon ' + (item.kind === 'Issue' ? 'issue' : 'pull')}>
                      {item.kind === 'Issue' ? <CircleDot size={18}/> : <GitPullRequest size={18}/>}
                    </span>
                    <span className="work-copy">
                      <span className="work-overline">{item.kind} #{item.number} · {item.author} · updated {relativeTime(item.updated_at)}
                        {item.activity.status !== 'unchanged' && <em className={'activity-badge ' + item.activity.status}>{item.activity.status === 'new' ? 'New' : 'Changed'}</em>}
                      </span>
                      <strong>{item.title}</strong>
                      <span className="signal-list">
                        <em className={'category ' + categoryTone(item.category)}>{item.category}</em>
                        {item.signals.slice(0, 3).map((signal) => <em key={signal}>{signal}</em>)}
                      </span>
                    </span>
                    <span className="attention-score"><strong>{item.score}</strong><small>attention</small><i><b style={{width: item.score + '%'}}/></i></span>
                  </button>
                ))}
                {!visibleItems.length && <div className="empty-queue"><Filter size={26}/><strong>No matching work</strong><span>Choose another filter or clear your search.</span></div>}
              </div>
            </div>

            {selected ? <aside className="detail-card">
              <div className="detail-topline">
                <span className={'type-icon ' + (selected.kind === 'Issue' ? 'issue' : 'pull')}>{selected.kind === 'Issue' ? <CircleDot size={17}/> : <GitPullRequest size={17}/>}</span>
                <span>{selected.kind} #{selected.number}</span>
                <a href={selected.url} target="_blank" rel="noreferrer">Open on GitHub <ArrowUpRight size={14}/></a>
              </div>
              <h2>{selected.title}</h2>
              <div className="author-line">
                {selected.avatar && <img src={selected.avatar} alt=""/>}
                <span>Opened by <strong>{selected.author}</strong></span>
                <span>·</span><span>{relativeTime(selected.created_at)}</span>
              </div>
              <div className="decision-box">
                <span className="decision-label">Recommended next action</span>
                <strong>{selected.action}</strong>
                <p>{selected.why_now}</p>
                <div className="decision-meta"><span><Clock3 size={12}/>{selected.estimated_minutes} min</span><span>{selected.outcome}</span><span>{Math.round(selected.confidence * 100)}% evidence confidence</span></div>
              </div>
              <div className="detail-tabs">
                <button className={detailTab === 'evidence' ? 'active' : ''} onClick={() => setDetailTab('evidence')}>Why this score</button>
                <button className={detailTab === 'files' ? 'active' : ''} onClick={() => setDetailTab('files')}>Changed files <span>{selected.files.length}</span></button>
              </div>

              {detailTab === 'evidence' ? <div className="evidence-section">
                {selected.evidence.map((entry, index) => <div className="evidence-item" key={entry.label + '-' + index}>
                  <span className={'evidence-status ' + entry.tone}>{entry.tone === 'positive' ? <Check size={14}/> : entry.tone === 'risk' ? <AlertCircle size={14}/> : <Eye size={14}/>}</span>
                  <span><strong>{entry.label}</strong><small>{entry.value}</small></span>
                </div>)}
                {selected.duplicate && <a className="duplicate-box" href={selected.duplicate.url} target="_blank" rel="noreferrer">
                  <span><Network size={16}/><strong>Related work detected</strong><em>{Math.round(selected.duplicate.similarity * 100)}% match</em></span>
                  <p>#{selected.duplicate.number} {selected.duplicate.title}</p>
                </a>}
              </div> : <div className="file-section">
                {selected.files.length ? <>
                  <div className="diff-summary"><span className="add">+{selected.additions}</span><span className="remove">−{selected.deletions}</span></div>
                  {selected.files.map((file) => <div className="file-item" key={file}><FileCode2 size={15}/><span>{file}</span></div>)}
                </> : <div className="no-files"><FileCode2 size={24}/><strong>No file data</strong><span>Issues do not contain changed files. Some PR file data may require API access.</span></div>}
              </div>}

              <div className="draft-section">
                <div className="draft-heading"><span><Bot size={16}/> Suggested response</span><em>Draft only</em></div>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Suggested response"/>
                <div className="draft-footer">
                  <span><ShieldCheck size={14}/> Nothing is posted automatically</span>
                  <button onClick={copyDraft}>{copied ? <CheckCircle2 size={14}/> : <Copy size={14}/>} {copied ? 'Copied' : 'Copy draft'}</button>
                </div>
              </div>
            </aside> : <aside className="detail-card empty-detail"><Eye size={28}/><strong>Select an item</strong><span>Its evidence and suggested action will appear here.</span></aside>}
          </section>

          <section className="policy-strip">
            <div><ShieldCheck size={17}/><span><strong>Repository policies</strong><small>{analysis.policies.length ? analysis.policies.length + ' policy sources found' : 'No standard policy files found'}</small></span></div>
            <div className="policy-pills">
              {analysis.policies.length ? analysis.policies.map((policy) => <a key={policy.path} href={policy.url} target="_blank" rel="noreferrer">{policy.name}<span>{policy.path}</span><ArrowUpRight size={12}/></a>) : <span className="no-policies">Add CODEOWNERS, CONTRIBUTING.md, or SECURITY.md to improve evidence.</span>}
            </div>
          </section>
        </main>
      )}

      <footer className="site-footer"><span>RepoSignal</span><p>Evidence helps you decide. It never decides for you.</p><a href="/api/health" target="_blank" rel="noreferrer">API status <span/></a></footer>
    </div>
  )
}

function Step({ number, icon, title, text }: { number: string; icon: React.ReactNode; title: string; text: string }) {
  return <article className="step-card"><span className="step-number">{number}</span><span className="step-icon">{icon}</span><h3>{title}</h3><p>{text}</p></article>
}

function SummaryCard({ icon, value, label, note, tone }: { icon: React.ReactNode; value: number; label: string; note: string; tone: string }) {
  return <article className={'summary-card ' + tone}><span className="summary-icon">{icon}</span><strong>{value}</strong><span>{label}</span><small>{note}</small></article>
}

function relativeTime(value: string) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago'
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago'
  if (seconds < 2592000) return Math.floor(seconds / 86400) + 'd ago'
  return Math.floor(seconds / 2592000) + 'mo ago'
}

function formatNumber(value: number) {
  return Intl.NumberFormat('en', { notation: value > 999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function categoryTone(category: string) {
  if (/security|impact|failing/i.test(category)) return 'risk'
  if (/ready|low-risk/i.test(category)) return 'positive'
  if (/duplicate|information/i.test(category)) return 'attention'
  return 'neutral'
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
