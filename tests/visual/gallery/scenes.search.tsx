// Search after Google answered with nothing new (hands-on test 2026-11-16): under local results the line reads
// "No more results on Google"; with no local results it is the empty state's own detail, under its sentence. The real
// SearchPage on original demo rows; the stand-in demo account cannot search on Google, so the page is drawn directly.

import type { ReactElement } from 'react';
import { SearchPage } from '../../../apps/desktop/src/renderer/screens/search/SearchPage';
import {
  initialSearch,
  resultRow,
  searchPage,
  type LocalResults,
} from '../../../apps/desktop/src/renderer/screens/search/search.model';
import { toSearchQuery } from '../../../apps/desktop/src/renderer/screens/search/parse';
import '../../../apps/desktop/src/renderer/screens/screens.css';

const NOW = 1_000;
const noop = () => undefined;
const THREAD = {
  id: 't1',
  fromName: 'Jordan Lee',
  subject: 'Print run for November',
  snippet: 'The proof is attached, invoice to follow',
  unread: false,
  lastDate: Date.parse('2026-10-28T09:00:00-07:00'),
  hasAttachments: true,
  workflow: { status: 'new' as const, bookmarked: false, hiddenFromHome: false },
  accountId: 'a1',
};

function scene(ids: string[]): () => ReactElement {
  return function SearchGoogleNoneScene(): ReactElement {
    const field = 'invoice';
    const local: LocalResults = { status: 'live', ids, total: ids.length };
    const state = {
      ...initialSearch,
      field,
      remote: { phase: 'done' as const, key: `all|${field}`, runId: 'r1', localIds: ids },
    };
    const model = searchPage(state, local, NOW);
    const rows = ids.map(() => resultRow(THREAD, toSearchQuery([], field), false));
    return (
      <div className="aplos-screen" style={{ height: '100%', width: 'min(720px, 100%)' }}>
        <div className="aplos-screen-fill">
          <SearchPage
            model={model}
            localRows={rows}
            remoteRows={[]}
            density="comfortable"
            scopeLabel="All accounts"
            handlers={{
              onChange: noop,
              onRemoveToken: noop,
              onSubmit: noop,
              onRetryResults: noop,
              onLeaveToList: noop,
              onSelectRow: noop,
              onOpenRow: noop,
              onRowAction: noop,
            }}
          />
        </div>
      </div>
    );
  };
}

export const searchScenes: Record<string, () => ReactElement> = {
  'search-google-none-local': scene(['t1']),
  'search-google-none-empty': scene([]),
};
