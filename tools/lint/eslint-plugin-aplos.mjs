// Local ESLint plugin. Rules: "aplos/boundaries" (import boundaries between the layers of the
// repo, configured from eslint.config.mjs) and "aplos/no-dangerous-html". See tools/lint/README.md.
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths are resolved against the repo root (this file's location), not the cwd, so running
// ESLint from inside a package gives the same answer as running it from the root.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const NODE_BUILTINS = new Set(builtinModules);

/** Convert a repo-relative glob (`**`, `*`) to a RegExp. `dir/**` also matches `dir` itself. */
export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i);
    if (rest.startsWith('/**') && rest.length === 3) {
      source += '(?:/.*)?';
      break;
    }
    if (rest.startsWith('**/')) {
      source += '(?:.*/)?';
      i += 2;
    } else if (rest.startsWith('**')) {
      source += '.*';
      i += 1;
    } else if (glob[i] === '*') source += '[^/]*';
    else source += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const matchesAny = (globs, file) => globs.some(glob => globToRegExp(glob).test(file));

function toPosix(file) {
  return file.split(path.sep).join('/');
}

/** The module specifier of a node, or undefined when it has none or is not a plain string. */
function literalValue(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
}

function isRequireCall(node) {
  return node.callee.type === 'Identifier' && node.callee.name === 'require';
}

/** Why a specifier is denied by one deny entry, or undefined when it is fine. */
function denyReason(deny, specifier, resolved) {
  const isRelative = specifier.startsWith('.');
  if (deny.specifier && new RegExp(deny.specifier).test(specifier)) return deny.message;
  if (deny.builtin && !isRelative) {
    const bare = specifier.replace(/^node:/, '');
    if (
      specifier.startsWith('node:') ||
      NODE_BUILTINS.has(bare) ||
      NODE_BUILTINS.has(bare.split('/')[0])
    ) {
      return deny.message;
    }
  }
  if (deny.path && isRelative && matchesAny(deny.path, resolved)) return deny.message;
  if (deny.segment && specifier.split('/').includes(deny.segment)) return deny.message;
  return undefined;
}

/** Why a specifier is outside an allow-list, or undefined when it is allowed. */
function allowReason(allow, specifier, resolved) {
  if (specifier.startsWith('.')) {
    if (!allow.relativeWithin || matchesAny(allow.relativeWithin, resolved)) return undefined;
    return allow.message;
  }
  const packages = allow.packages ?? [];
  const allowed = packages.some(name => specifier === name || specifier.startsWith(`${name}/`));
  return allowed ? undefined : allow.message;
}

/** Every reason a zone rejects a specifier (deny entries first, then the allow-list). */
function zoneReasons(zone, specifier, resolved) {
  const reasons = (zone.deny ?? []).map(entry => denyReason(entry, specifier, resolved));
  if (zone.allow) reasons.push(allowReason(zone.allow, specifier, resolved));
  return reasons.filter(Boolean);
}

function zoneApplies(zone, file) {
  return matchesAny(zone.from, file) && !matchesAny(zone.except ?? [], file);
}

const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce import boundaries between the layers of the repo' },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['zones'],
        properties: {
          zones: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'from'],
              properties: {
                name: { type: 'string' },
                from: { type: 'array', items: { type: 'string' } },
                except: { type: 'array', items: { type: 'string' } },
                flagDynamic: { type: 'boolean' },
                deny: { type: 'array', items: { type: 'object' } },
                allow: { type: 'object' },
              },
            },
          },
        },
      },
    ],
    messages: {
      denied: '[{{zone}}] import of "{{specifier}}" is not allowed: {{reason}}',
      dynamic:
        '[{{zone}}] dynamic import or require with a non-literal specifier cannot be checked.',
    },
  },
  create(context) {
    const zones = context.options[0]?.zones ?? [];
    const file = toPosix(path.relative(REPO_ROOT, context.filename));
    const active = zones.filter(zone => zoneApplies(zone, file));
    if (active.length === 0) return {};

    function checkSpecifier(node, specifier) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      for (const zone of active) {
        for (const reason of zoneReasons(zone, specifier, resolved)) {
          const data = { zone: zone.name, specifier, reason };
          context.report({ node, messageId: 'denied', data });
        }
      }
    }

    function checkDynamic(node) {
      for (const zone of active) {
        if (zone.flagDynamic)
          context.report({ node, messageId: 'dynamic', data: { zone: zone.name } });
      }
    }

    function checkSource(node, sourceNode) {
      const specifier = literalValue(sourceNode);
      if (specifier !== undefined) checkSpecifier(node, specifier);
    }

    return {
      ImportDeclaration: node => checkSource(node, node.source),
      ExportAllDeclaration: node => checkSource(node, node.source),
      ExportNamedDeclaration: node => node.source && checkSource(node, node.source),
      TSImportEqualsDeclaration(node) {
        const ref = node.moduleReference;
        if (ref.type === 'TSExternalModuleReference') checkSource(node, ref.expression);
      },
      TSImportType: node => checkSource(node, node.argument?.literal ?? node.argument),
      ImportExpression(node) {
        const specifier = literalValue(node.source);
        if (specifier === undefined) checkDynamic(node);
        else checkSpecifier(node, specifier);
      },
      CallExpression(node) {
        if (!isRequireCall(node) || node.arguments.length === 0) return;
        const specifier = literalValue(node.arguments[0]);
        if (specifier === undefined) checkDynamic(node);
        else checkSpecifier(node, specifier);
      },
    };
  },
};

const HTML_PROP = 'dangerouslySetInnerHTML';

/** Flags React's raw-HTML prop however it is written: JSX attribute, object key (spread props, createElement). */
const noDangerousHtml = {
  meta: {
    type: 'problem',
    docs: {
      description: `Disallow ${HTML_PROP}; turn the rule off only for the sandboxed mail frame`,
    },
    schema: [],
    messages: {
      banned: `${HTML_PROP} is allowed only in apps/desktop/src/renderer/mailframe (ARCHITECTURE 10).`,
    },
  },
  create(context) {
    const report = node => context.report({ node, messageId: 'banned' });
    return {
      JSXAttribute: node => node.name.name === HTML_PROP && report(node),
      Property(node) {
        if (node.parent.type !== 'ObjectExpression') return; // destructuring only reads the prop
        const key = node.key;
        const named = key.type === 'Identifier' && !node.computed && key.name === HTML_PROP;
        if (named || literalValue(key) === HTML_PROP) report(node);
      },
    };
  },
};

export default {
  meta: { name: 'eslint-plugin-aplos' },
  rules: { boundaries: rule, 'no-dangerous-html': noDangerousHtml },
};
