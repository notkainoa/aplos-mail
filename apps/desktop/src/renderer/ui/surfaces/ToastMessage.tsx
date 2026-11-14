/**
 * ToastMessage: a toast's words. A countdown message ("Sending to Jordan in 8 s") keeps " in 8 s" on one line and
 * shortens the recipients with an ellipsis instead, so the unit never lands alone on a second line. Any other
 * message is plain text, wrapped to two lines by the stylesheet.
 */

const COUNTDOWN = /^(.*\S)(\s+in\s+\d+\s*(?:s|seconds?))$/;

export interface CountdownSplit {
  lead: string;
  tail: string;
}

/** Splits "Sending to <who> in 8 s" into the shrinking part and the part that never wraps; null for other text. */
export function splitCountdown(message: string): CountdownSplit | null {
  const match = COUNTDOWN.exec(message);
  return match ? { lead: match[1] ?? '', tail: match[2] ?? '' } : null;
}

export function ToastMessage({ message }: { message: string }) {
  const split = splitCountdown(message);
  if (!split) return <span className="ui-toast__message">{message}</span>;
  return (
    <span className="ui-toast__message" data-countdown="">
      <span className="ui-toast__lead" title={split.lead}>
        {split.lead}
      </span>
      <span className="ui-toast__tail">{split.tail}</span>
    </span>
  );
}
