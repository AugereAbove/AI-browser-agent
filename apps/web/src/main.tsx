import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, ClientError, runSchema, runsSchema, scenariosSchema } from './client.ts';
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
  function failure(value: unknown) {
    setError(value instanceof ClientError ? value.code.replaceAll('_', ' ') : 'Unable to load data. Try again.');
    if (value instanceof ClientError && value.code === 'unauthorized') disconnect();
  }
  function disconnect() {
    client?.close(); setClient(null); setToken(''); setScenarios([]); setRuns([]); setSelected(null); setBusy(false);
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
  async function refresh() {
    if (!client || busy) return;
    setBusy(true); setError('');
    try { const value = await client.request('/v1/runs', runsSchema); if (client.active) setRuns(value.runs); }
    catch (value) { if (client.active || value instanceof ClientError) failure(value); } finally { if (client.active) setBusy(false); }
  }
  async function inspect(id: string) {
    if (!client || busy) return;
    setBusy(true); setError('');
    try { const value = await client.request(`/v1/runs/${id}`, runSchema); if (client.active) setSelected(value); }
    catch (value) { if (client.active || value instanceof ClientError) failure(value); } finally { if (client.active) setBusy(false); }
  }
  return <main>
    <header><div><span className="eyebrow">LOCAL WORKSPACE</span><h1>Browser Agent</h1></div><div className="connection"><span className={client ? 'light connected' : 'light'} />{client ? 'Connected' : 'Disconnected'}{client && <button onClick={disconnect}>Disconnect</button>}</div></header>
    {!client ? <section className="login"><span className="eyebrow">YOUR BROWSER, BOUNDED</span><h2>Connect to your workspace</h2><p>Use the API key configured for this local server. It stays in memory and is cleared when you disconnect or reload.</p><form onSubmit={connect}><label htmlFor="token">API key</label><input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} disabled={connecting} required maxLength={256} /><button className="primary" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect'}</button></form></section> : <>
      <section><div className="section-heading"><div><span className="eyebrow">TASK GALLERY</span><h2>Read and verify</h2></div><span className="badge">Synthetic fixtures</span></div><p>Deterministic read tasks with independent verification. Browser writes are disabled.</p><div className="gallery">{scenarios.map((scenario) => <article key={scenario.id}><span className="eyebrow">READ ONLY</span><h3>{scenario.title}</h3><p>Seed {scenario.seed} · {scenario.permission_scope.replaceAll('-', ' ')}</p></article>)}</div></section>
      <section><div className="section-heading"><h2>Run history</h2><button onClick={() => void refresh()} disabled={busy}>Refresh history</button></div>{runs.length === 0 ? <p>No runs yet.</p> : <div className="history">{runs.map((run) => <button className="history-row" key={run.run_id} onClick={() => void inspect(run.run_id)} disabled={busy}><span><strong>{run.template_id}</strong><small>{run.run_id}</small></span><span className={`badge ${run.state}`}>{run.state.replaceAll('_', ' ')}</span><time>{new Date(run.created_at).toLocaleString()}</time></button>)}</div>}</section>
      {selected && <section aria-label="Run detail"><div className="section-heading"><h2>Run detail</h2><span className={`badge ${selected.state}`}>{selected.state.replaceAll('_', ' ')}</span></div><p className="mono">{selected.runId}</p><p>{selected.events.length} recorded events. Viewing history never executes an action.</p><ol className="events">{selected.events.map((event) => <li key={event.sequence}><span className="event-number">{event.sequence}</span><strong>{event.type.replaceAll('_', ' ')}</strong><span>{event.reason ?? event.actionType ?? event.state.replaceAll('_', ' ')}</span></li>)}</ol></section>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    <footer>Local fixture runner · Independent verification · No model required</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
