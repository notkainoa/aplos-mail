// Banned words used as identifiers and code strings are not copy.
const todo = 'todo';
const airmailBlue = 'ink blue';
const mode = 'smart';
const sentWith = 'sent-with';
const magicLinkId = 'magic';

export const route = { id: 'todo', path: '/todo', kind: 'beta', name: 'Todo' };

export function View({ count }: { count: number }) {
  return (
    <div className="todo hide-all" data-state="smart" id="beta" role="list">
      <h2>Later</h2>
      <p>Go one by one</p>
      <p>Reply · R. Hold R to dictate</p>
      <p>You handled 12 emails.</p>
      <p>Clear from Home</p>
      <p>Ask about your mail or calendar</p>
      <p>Aplos can't reach its mail engine.</p>
      <p>Open Aplos when you log in.</p>
      <p>Today</p>
      <p>Smart folders are not offered.</p>
      <p>The beta channel is in Settings.</p>
      <p>{count} emails need a reply</p>
      <button aria-label="Mark done" title="Done, then next (E)">Done</button>
      <input placeholder="Search mail" aria-label="Search" data-testid="smart" type="search" />
      <Item kind="todo" tone="airmail" variant="text" icon="clock" mode={mode} />
    </div>
  );
}

export const items = [
  { label: 'Later', id: 'later' },
  { title: 'Show all key hints', description: 'Keycaps stay visible.' },
  { text: count => `${count} done` },
  { value: 'Todo!' },
];

function Item(props: Record<string, unknown>) {
  return <i {...props} />;
}

export const keys = { todo, airmailBlue, sentWith, magicLinkId };

export function codeCalls(list: string[], toast: (message: string) => void) {
  console.log('Done! todo');
  list.includes('todo');
  document.querySelector('.low');
  document.body.setAttribute('data-state', 'todo');
  toast('Moved to Later');
  return { context: 'todo', labelledBy: 'airmail-field' };
}
