// Every byte of output text and attribute values passes through here. Escaping `<` and `>` in
// attribute values too means no reading of the output can find markup inside a value.

const TEXT = /[&<>\u0000]/g;
const ATTRIBUTE = /[&<>"'`\u0000]/g;

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '\u0000': '�',
};

function entity(char: string): string {
  return ENTITIES[char] ?? char;
}

export function escapeText(text: string): string {
  return text.replace(TEXT, entity);
}

export function escapeAttribute(value: string): string {
  return value.replace(ATTRIBUTE, entity);
}
