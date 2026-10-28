import { useState } from 'react';
import type { DomainReport } from '@aplos/engine/legacy/discover';
import { invoke } from '../bridge';
import { Badge, Button, Notice } from '../ui';

const tone = { pass: 'green', warn: 'amber', fail: 'red', unknown: 'neutral' } as const;
const word = { pass: 'OK', warn: 'Check', fail: 'Fix', unknown: 'Unknown' } as const;

/** Checks that a custom domain's mail records (MX, SPF, DKIM, DMARC) are set up for its host. */
export function DomainCheck({ initial }: { initial?: string }) {
  const [domain, setDomain] = useState(initial ?? '');
  const [report, setReport] = useState<DomainReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function check() {
    setBusy(true);
    setError('');
    try {
      setReport(
        await invoke<DomainReport>('domain.check', { domain: domain.trim().toLowerCase() }),
      );
    } catch (e) {
      setError((e as Error).message);
      setReport(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="domain-check">
      <form
        onSubmit={e => {
          e.preventDefault();
          if (domain.trim()) void check();
        }}
      >
        <input
          aria-label="Domain"
          value={domain}
          placeholder="example.com"
          spellCheck={false}
          autoCapitalize="off"
          onChange={e => setDomain(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={!domain.trim()}
        >
          Check
        </Button>
      </form>
      {error && <Notice>{error}</Notice>}
      {report && (
        <ul className="domain-results" aria-label={`Mail records for ${report.domain}`}>
          {report.checks.map(item => (
            <li key={item.id}>
              <Badge tone={tone[item.status]}>{word[item.status]}</Badge>
              <div>
                <span>{item.title}</span>
                <p>{item.detail}</p>
                {item.fix && <p className="domain-fix">{item.fix}</p>}
                {item.records.length > 0 && <code>{item.records.join('\n')}</code>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
