export function View({ count }: { count: number }) {
  return (
    <div>
      <p>Swipe through them</p> {/* @expect */}
      <p>Hold to talk</p> {/* @expect */}
      <p>Hold Space to talk</p> {/* @expect */}
      <p>Tap to write · hold to talk</p> {/* @expect */}
      <button>Hide all</button> {/* @expect */}
      <h2>Todo</h2> {/* @expect */}
      <h2>{count} Todos</h2> {/* @expect */}
      <p>Be here now</p> {/* @expect */}
      <p>Sent with Aplos</p> {/* @expect */}
      <p>Ask me anything</p> {/* @expect */}
      <p>Add a little magic to your inbox</p> {/* @expect */}
      <p>AI-powered summaries</p> {/* @expect */}
      <p>AI powered replies</p> {/* @expect */}
      <p>Meet your Copilot</p> {/* @expect */}
      <p>Ready when you are</p> {/* @expect */}
      <p>Waiting on you</p> {/* @expect */}
      <p>No reply yet</p> {/* @expect */}
      <p>All clear for now</p> {/* @expect */}
      <p>Making room for your mail…</p> {/* @expect */}
      <p>Aplos needs a moment.</p> {/* @expect */}
      <p>Couldn't summarize this email</p> {/* @expect */}
      <p>Couldn’t summarize this email</p> {/* @expect */}
      <p>Your day beside your mail</p> {/* @expect */}
      <p>A comfortable place for your mail.</p> {/* @expect */}
      <p>Make light work of your inbox.</p> {/* @expect */}
      <p>A little less inbox. A little more life.</p> {/* @expect */}
      <p>Aplos is ready when your day begins.</p> {/* @expect */}
      <p>Skypaper</p> {/* @expect */}
      <p>Airmail</p> {/* @expect */}
      <p>Sent par avion</p> {/* @expect */}
      <span>Smart</span> {/* @expect */}
      <span>Beta</span> {/* @expect */}
      <p>Welcome!</p> {/* @expect */}
      <p>{count > 1 ? 'Done!' : 'Nothing here'}</p> {/* @expect */}
      <p>{'Hide all'}</p> {/* @expect */}
      <input
        placeholder="Ask me anything" // @expect
        aria-label="Hold to talk" // @expect
        title="Move to Todo" // @expect
        alt={count ? 'All clear for now' : 'x'} // @expect
        label="Smart" // @expect
        hint="Hurry!" // @expect
        data-note="ok"
      />
    </div>
  );
}

export const items = [
  { label: 'Todo', id: 'todo' }, // @expect
  { title: 'Hide all', id: 'hide' }, // @expect
  { description: 'Your day beside your mail' }, // @expect
  { placeholder: 'Ask me anything' }, // @expect
  { ariaLabel: 'Swipe through them' }, // @expect
  { hint: 'Hold to talk' }, // @expect
  { tooltip: 'Hold Space to talk' }, // @expect
  { message: `Sent with ${'Aplos'}` }, // @expect
  { copy: 'Be here now' }, // @expect
  { text: 'You did it!' }, // @expect
  { label: 'Beta' }, // @expect
  { 'aria-label': 'Airmail' }, // @expect
];

declare const toast: (message: string) => void;
declare const group: (title: string, rows: unknown[]) => unknown;

export function copyInCalls(rows: unknown[]) {
  toast('All clear for now!'); // @expect
  window.confirm('Hide all?'); // @expect
  document.title = 'Airmail'; // @expect
  group('Ready when you are', rows); // @expect
  group('No reply yet', rows); // @expect
  document.body.setAttribute('aria-label', 'Todo'); // @expect
  toast('Saved!'); // @expect
  return { emptyLabel: 'No reply yet', confirmLabel: 'Ready when you are' }; // @expect
}
