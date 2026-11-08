import { useEffect, useRef, useState } from 'react';
import { approvalSchema, approvalsSchema, artifactsSchema, ClientError } from './client.ts';
import type { ApiClient, Run, Artifact } from './client.ts';

export function RunRecords({ api, run, onUnauthorized }: { api: ApiClient; run: Run; onUnauthorized: () => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [approvals, setApprovals] = useState<ReturnType<typeof approvalsSchema.parse>['approvals'] | null>(null);
  const [ticket, setTicket] = useState<ReturnType<typeof approvalSchema.parse> | null>(null);
  const [evidence, setEvidence] = useState<Awaited<ReturnType<ApiClient['evidence']>> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  function failed(value: unknown) {
    if (value instanceof ClientError && value.code === 'unauthorized') unauthorized.current();
    else setError(value instanceof ClientError ? value.code.replaceAll('_', ' ') : 'Unable to read run records.');
  }
  useEffect(() => {
    const abort = new AbortController();
    setArtifacts(null); setApprovals(null); setTicket(null); setEvidence(null); setError(''); setBusy(false);
    void Promise.all([
      api.request(`/v1/runs/${run.runId}/artifacts`, artifactsSchema, undefined, undefined, abort.signal),
      api.request(`/v1/runs/${run.runId}/approvals`, approvalsSchema, undefined, undefined, abort.signal),
    ]).then(([a, b]) => {
      if (abort.signal.aborted) return;
      if (a.run_id !== run.runId || b.run_id !== run.runId) throw new ClientError('invalid_response');
      setArtifacts(a.artifacts); setApprovals(b.approvals);
    }).catch(value => { if (!abort.signal.aborted) failed(value); });
    return () => { abort.abort(); operation.current?.abort(); operation.current = null; };
  }, [api, run.runId, run.state, revision]);
  async function inspect(load: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const abort = new AbortController();
    operation.current = abort; setBusy(true); setError('');
    try { await load(abort.signal); }
    catch (value) { if (!abort.signal.aborted) failed(value); }
    finally { if (operation.current === abort) { operation.current = null; setBusy(false); } }
  }
  function openEvidence(artifact: Artifact) {
    setEvidence(null);
    return inspect(async signal => {
      const result = await api.evidence(run.runId, artifact, signal);
      if (!signal.aborted) setEvidence(result);
    });
  }
  function openApproval(action: string) {
    setTicket(null);
    return inspect(async signal => {
      const record = await api.request(`/v1/runs/${run.runId}/approvals/${action}`, approvalSchema, undefined, undefined, signal);
      if (record.run_id !== run.runId || record.binding.run_id !== run.runId ||
          record.action_id !== action || record.binding.action_id !== action || record.binding.action.id !== action) throw new ClientError('invalid_response');
      if (!signal.aborted) setTicket(record);
    });
  }
  function download() {
    if (!evidence) return;
    const url = URL.createObjectURL(new Blob([evidence.bytes], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `product-evidence-${run.runId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="records">
    <button disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh run records</button>
    <div><h3>Verification evidence</h3>
      {artifacts?.length === 0 && <p>No unexpired evidence for this run.</p>}
      {artifacts?.map(artifact => <button key={artifact.artifact_id} disabled={busy} onClick={() => void openEvidence(artifact)}>Inspect evidence</button>)}
      {evidence && <><p>{evidence.evidence.verification.verified ? 'Verified' : 'Verification failed'} · {evidence.evidence.verification.reason.replaceAll('_', ' ')}</p>
        {evidence.evidence.records.length === 0 ? <p>No matching products.</p> : <ul>{evidence.evidence.records.map((record, index) => <li key={`${record.id}-${index}`}>{record.id} · {(record.priceCents / 100).toFixed(2)} PLN</li>)}</ul>}
        <button onClick={download}>Download verified JSON</button></>}
    </div>
    <div><h3>Approval records</h3>
      {approvals?.length === 0 && <p>No approval requested.</p>}
      {approvals?.map(approval => <button key={approval.action_id} disabled={busy} onClick={() => void openApproval(approval.action_id)}>
        {approval.action_type} · {approval.action_id} · {approval.status}
      </button>)}
      {ticket && <><p>{ticket.status} · expires {new Date(ticket.binding.expires_at).toLocaleString()}</p>
        <p className="mono">{ticket.binding.destination}</p><pre>{JSON.stringify(ticket.binding.action, null, 2)}</pre>
        <p className="mono">State digest: {ticket.binding.state_digest}</p><p className="mono">Approval digest: {ticket.digest}</p>
        <p>Inspection only. Browser writes remain disabled.</p></>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
