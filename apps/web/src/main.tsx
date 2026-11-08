import { RunRecords } from './records.tsx';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, ClientError, admissionSchema, cancellationSchema, eventsSchema, isLive, mergeEvents, runSchema, runsSchema, scenariosSchema } from './client.ts';
import type { Run, Scenario } from './client.ts';

function App() {
  const [token, setToken] = useState('');
  const [client, setClient] = useState<ApiClient | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState<ReturnType<typeof runsSchema.parse>['runs']>([]);
  const [selected, setSelected] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [liveError, setLiveError] = useState(false);
  const [liveFailures, setLiveFailures] = useState(0);
  const pending = useRef(false);
  const submission = useRef<{ scenario: string; key: string } | null>(null);
  const cancellation = useRef<{ run: string; key: string } | null>(null);
  function failure(value: unknown) {
    setError(value instanceof ClientError ? value.code.replaceAll('_', ' ') : 'Unable to load data. Try again.');
    if (value instanceof ClientError && value.code === 'unauthorized') disconnect();
  }
  function disconnect() {
    client?.close(); pending.current = false; submission.current = null; cancellation.current = null; setClient(null); setToken(''); setScenarios([]); setRuns([]); setSelected(null); setBusy(false);
  }
  useEffect(() => {
    const leave = () => { client?.close(); setClient(null); setScenarios([]); setRuns([]); setSelected(null); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); client?.close(); };
  }, [client]);
  async function connect(event: FormEvent) {
    event.preventDefault(); setConnecting(true); setError('');
    let candidate: ApiClient | null = null;
    try {
      candidate = new ApiClient(token); setToken('');
      const [gallery, history] = await Promise.all([candidate.request('/v1/scenarios', scenariosSchema), candidate.request('/v1/runs', runsSchema)]);
      setScenarios(gallery.scenarios); setRuns(history.runs); setClient(candidate);
    } catch (value) { candidate?.close(); failure(value); } finally { setToken(''); setConnecting(false); }
  }
  useEffect(() => {
    if (!client || !selected || !isLive(selected) || liveError) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const batch = await client.request(`/v1/runs/${selected.runId}/events?after=${selected.sequence}`, eventsSchema, undefined, undefined, abort.signal);
        if (abort.signal.aborted || !client.active) return;
        const next = mergeEvents(selected, batch);
        setLiveFailures(0);
        setSelected(current => current === selected ? next : current);
        if (next.sequence !== selected.sequence) setRuns(items => items.map(run => run.run_id === next.runId ? { ...run, state: next.state, sequence: next.sequence } : run));
      } catch (value) {
        if (!abort.signal.aborted) {
          const retryable = value instanceof TypeError || (value instanceof DOMException && value.name === 'TimeoutError') ||
            (value instanceof ClientError && value.code === 'request_failed');
          if (retryable && liveFailures < 2) setLiveFailures(count => count + 1);
          else { setLiveError(true); failure(value); }
        }
      }
    }, 750 * 2 ** liveFailures);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [client, selected, liveError, liveFailures]);
  async function operate(operation: (api: ApiClient) => Promise<void>) {
    if (!client || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await operation(client); }
    catch (value) { if (client.active || (value instanceof ClientError && value.code === 'unauthorized')) failure(value); }
    finally { if (client.active) { pending.current = false; setBusy(false); } }
  }
  async function loadRun(api: ApiClient, id: string) {
    const value = await api.request(`/v1/runs/${id}`, runSchema);
    if (value.runId !== id) throw new ClientError('invalid_response');
    if (api.active) { setLiveError(false); setLiveFailures(0); setSelected(current => current?.runId === id && current.sequence > value.sequence ? current : value); }
  }
  function refresh() { return operate(async api => { const value = await api.request('/v1/runs', runsSchema); if (api.active) setRuns(value.runs); }); }
  function inspect(id: string) { return operate(api => loadRun(api, id)); }
  function start(scenario: Scenario) {
    return operate(async api => {
      if (submission.current && submission.current.scenario !== scenario.id) throw new ClientError('retry_the_previous_task_first');
      const attempt = submission.current ??= { scenario: scenario.id, key: crypto.randomUUID() };
      const value = await api.request('/v1/runs', admissionSchema, { template_id: scenario.template_id, input: scenario.input, seed: scenario.seed }, attempt.key);
      if (!api.active) return;
      submission.current = null;
      await loadRun(api, value.run_id);
      const history = await api.request('/v1/runs', runsSchema);
      if (api.active) setRuns(history.runs);
    });
  }
  function cancel(run: Run) {
    return operate(async api => {
      const attempt = cancellation.current?.run === run.runId ? cancellation.current : { run: run.runId, key: crypto.randomUUID() };
      cancellation.current = attempt;
      await api.request(`/v1/runs/${run.runId}/cancel`, cancellationSchema, {}, attempt.key);
      await loadRun(api, run.runId);
      const history = await api.request('/v1/runs', runsSchema);
      if (api.active) setRuns(history.runs);
    });
  }
  return <main>
    <header><div><span className="eyebrow">LOCAL WORKSPACE</span><h1>Browser Agent</h1></div><div className="connection"><span className={client ? 'light connected' : 'light'} />{client ? 'Connected' : 'Disconnected'}{client && <button onClick={disconnect}>Disconnect</button>}</div></header>
    {!client ? <section className="login"><span className="eyebrow">YOUR BROWSER, BOUNDED</span><h2>Connect to your workspace</h2><p>Use the API key configured for this local server. It stays in memory and is cleared when you disconnect or reload.</p><form onSubmit={connect}><label htmlFor="token">API key</label><input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} disabled={connecting} required maxLength={256} /><button className="primary" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect'}</button></form></section> : <>
      <section><div className="section-heading"><div><span className="eyebrow">TASK GALLERY</span><h2>Read and verify</h2></div><span className="badge">Synthetic fixtures</span></div><p>Deterministic read tasks with independent verification. Browser writes are disabled.</p><div className="gallery">{scenarios.map((scenario) => <article key={scenario.id}><span className="eyebrow">READ ONLY</span><h3>{scenario.title}</h3><p>Seed {scenario.seed} · {scenario.permission_scope.replaceAll('-', ' ')}</p><button className="primary" disabled={busy} onClick={() => void start(scenario)}>Run task</button></article>)}</div></section>
      <section><div className="section-heading"><h2>Run history</h2><button onClick={() => void refresh()} disabled={busy}>Refresh history</button></div>{runs.length === 0 ? <p>No runs yet.</p> : <div className="history">{runs.map((run) => <button className="history-row" key={run.run_id} onClick={() => void inspect(run.run_id)} disabled={busy}><span><strong>{run.template_id}</strong><small>{run.run_id}</small></span><span className={`badge ${run.state}`}>{run.state.replaceAll('_', ' ')}</span><time>{new Date(run.created_at).toLocaleString()}</time></button>)}</div>}</section>
      {selected && <section aria-label="Run detail"><div className="section-heading"><h2>Run detail</h2><span className={`badge ${selected.state}`}>{selected.state.replaceAll('_', ' ')}</span></div><p className="mono">{selected.runId}</p>{isLive(selected) && <div className="controls"><button disabled={busy} onClick={() => void cancel(selected)}>Cancel run</button><button disabled={busy} onClick={() => void inspect(selected.runId)}>Refresh run</button>{liveError && <button disabled={busy} onClick={() => { setError(''); setLiveFailures(0); setLiveError(false); }}>Resume updates</button>}<span role="status">{liveError ? 'Live updates paused' : liveFailures ? 'Reconnecting to this run' : 'Watching this run'}</span></div>}<p>{selected.events.length} recorded events. Viewing history never executes an action.</p><ol className="events">{selected.events.map((event) => <li key={event.sequence}><span className="event-number">{event.sequence}</span><strong>{event.type.replaceAll('_', ' ')}</strong><span>{event.reason ?? event.actionType ?? event.state.replaceAll('_', ' ')}</span></li>)}</ol><RunRecords key={selected.runId} api={client} run={selected} onUnauthorized={disconnect} /></section>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    <footer>Local fixture runner · Independent verification · No model required</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
