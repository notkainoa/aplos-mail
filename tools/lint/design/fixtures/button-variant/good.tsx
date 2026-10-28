import { Button } from '../ui';

const variant = 'text';

export function View({ busy, variantFromProps }: { busy: boolean; variantFromProps: 'filled' | 'text' | 'icon' }) {
  return (
    <div>
      <Button variant="filled">Send</Button>
      <Button variant="text">Later</Button>
      <Button variant="icon" aria-label="Close" />
      <Button variant={busy ? 'filled' : 'text'}>Send</Button>
      <Button variant={variant}>Later</Button>
      <Button variant={variantFromProps}>Done</Button>
      <Button>Default</Button>
      <Other variant="pill" />
    </div>
  );
}

function Other(props: { variant: string }) {
  return <i>{props.variant}</i>;
}

export const spreadOk = <Button {...{ variant: 'filled' }}>Go</Button>;
