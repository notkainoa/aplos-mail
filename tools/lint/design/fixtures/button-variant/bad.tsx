import { Button } from '../ui';

const tone = 'glass';

export function View({ busy, armed }: { busy: boolean; armed: boolean }) {
  return (
    <div>
      <Button variant="pill">Reply</Button> {/* @expect */}
      <Button variant="glass">Reply</Button> {/* @expect */}
      <Button variant="ghost">Later</Button> {/* @expect */}
      <Button variant="primary">Send</Button> {/* @expect */}
      <Button variant="secondary">Cancel</Button> {/* @expect */}
      <Button variant={'danger'}>Delete</Button> {/* @expect */}
      <Button variant={busy ? 'filled' : 'primary'}>Send</Button> {/* @expect */}
      <Button variant={armed ? 'pill' : busy ? 'text' : 'secondary'}>Done</Button> {/* @expect */}
      <Button variant={busy && 'ghost'}>Done</Button> {/* @expect */}
      <Button variant={tone}>Done</Button> {/* @expect */}
      <Button
        variant={`outline`} // @expect
      >
        Done
      </Button>
      <ui.Button variant="link">Open</ui.Button> {/* @expect */}
    </div>
  );
}

const ui = { Button };

import { Button as Btn } from '../ui';

export const aliased = <Btn variant="pill">Go</Btn>; // @expect
export const spread = <Btn {...{ variant: 'ghost' }}>Go</Btn>; // @expect
