// Summary (DESIGN §4.3, §6, §9 rules 1, 3, 5, 7). Mockups: home.html, reader.html (pending, no-ai).
// The one big line: Newsreader `summary` 21/31 when ready, identical on Home and in the reader. Pending shows
// the subject in SF, breathing (`breathe`, --ink-2). Absent shows the subject in SF and nothing else changes:
// no error, no glyph. Provenance only on hover: "Summary by Groq", "… on this Mac".

import type { SummaryProps } from '../props';

/** The summary slot in its pending, absent or ready state. */
export function Summary(props: SummaryProps) {
  const { clamp = 'none', id, lead } = props;
  const leading = lead ? <span className="ui-summary__lead">{lead}</span> : null;
  // With a lead, the words get their own span so a fade can reach them and leave the chip standing.
  const words = (text: string) => (lead ? <span className="ui-summary__text">{text}</span> : text);
  if (props.state === 'ready') {
    const { provider, local } = props.provenance;
    const provenance = `Summary by ${provider}${local ? ' on this Mac' : ''}`;
    return (
      <p
        id={id}
        className="ui-summary"
        dir="auto"
        data-state="ready"
        data-clamp={clamp}
        title={provenance}
      >
        {leading}
        {words(props.text)}
        <span className="ui-summary__subject"> Subject: {props.subject}</span>
      </p>
    );
  }
  return (
    <p
      id={id}
      className="ui-summary"
      dir="auto"
      data-state={props.state}
      data-clamp={clamp}
      aria-busy={props.state === 'pending' ? true : undefined}
    >
      {leading}
      {words(props.subject)}
    </p>
  );
}
