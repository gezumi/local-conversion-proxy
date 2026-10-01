// Codex tool declarations -> MCP relay tools, and back.
//
// Each supported declaration (direct function, function inside a namespace,
// custom/freeform) gets an opaque, stable MCP name. The table is the only way
// back from an MCP name to the original name/namespace/kind. Arguments are
// validated with Ajv before anything reaches Codex; remote `$ref`s are never
// fetched (no `loadSchema`), an unresolvable schema only enforces "object".

import { createHash, randomBytes } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { bridgeError } from './errors.mjs';

const MAX_MCP_NAME = 52; // 64 (Claude tool name) - "mcp__codex__".length

const CUSTOM_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    input: { type: 'string', description: 'The complete raw input for this freeform tool, in the exact format its description specifies.' },
  },
  required: ['input'],
  additionalProperties: false,
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sha(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** Deterministic JSON (sorted keys) for fingerprints. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function opaqueName(kind, namespace, name) {
  const readable = `${namespace ? `${namespace}__` : ''}${name}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const tag = sha(`${kind}\u0000${namespace ?? ''}\u0000${name}`).slice(0, 8);
  return `${readable.slice(0, MAX_MCP_NAME - tag.length - 1)}_${tag}`;
}

function compileValidator(schema) {
  try {
    const draft2020 = typeof schema?.$schema === 'string' && schema.$schema.includes('2020-12');
    const AjvClass = draft2020 ? Ajv2020 : Ajv;
    const ajv = new AjvClass({ strict: false, validateFormats: false, allErrors: false, validateSchema: false });
    const fn = ajv.compile(schema);
    return (value) => {
      if (fn(value)) return null;
      const e = fn.errors?.[0];
      return `${e?.instancePath || '(root)'} ${e?.message ?? 'is invalid'}`.slice(0, 300);
    };
  } catch {
    // Unresolvable/unsupported schema: we cannot validate beyond the object shape.
    return (value) => (isPlainObject(value) ? null : '(root) must be object');
  }
}

function normalizeParameters(parameters) {
  if (!isPlainObject(parameters)) return { type: 'object', properties: {} };
  if (parameters.type === undefined) return { ...parameters, type: 'object' };
  return parameters;
}

function describeCustom(tool) {
  const parts = [typeof tool.description === 'string' ? tool.description : ''];
  const f = tool.format;
  if (isPlainObject(f) && f.type === 'grammar' && typeof f.definition === 'string') {
    parts.push(`Freeform input format (${typeof f.syntax === 'string' ? f.syntax : 'grammar'} grammar):\n${f.definition}`);
  }
  parts.push('Pass the complete raw text as the "input" argument.');
  return parts.filter(Boolean).join('\n\n');
}

export class ToolTable {
  /** mcpName -> entry */
  #byMcp = new Map();
  skipped = 0;
  fingerprint;

  constructor(codexTools, { maxDescriptionChars }) {
    if (codexTools !== undefined && !Array.isArray(codexTools)) throw bridgeError('bad_request', { where: 'tools' });
    const fp = [];
    for (const tool of codexTools ?? []) {
      if (!isPlainObject(tool) || typeof tool.type !== 'string') {
        this.skipped += 1;
        continue;
      }
      if (tool.type === 'function') {
        this.#addFunction(tool, null, maxDescriptionChars);
      } else if (tool.type === 'namespace') {
        if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) throw bridgeError('bad_request', { where: 'namespace' });
        for (const inner of tool.tools) {
          if (!isPlainObject(inner)) throw bridgeError('bad_request', { where: 'namespace_tool' });
          if (inner.type === 'function') this.#addFunction(inner, tool, maxDescriptionChars);
          else if (inner.type === 'custom') this.#addCustom(inner, tool, maxDescriptionChars);
          else this.skipped += 1;
        }
      } else if (tool.type === 'custom') {
        this.#addCustom(tool, null, maxDescriptionChars);
      } else {
        // Provider-side tools (web_search, image_generation, ...) and kinds this proxy does not know.
        this.skipped += 1;
      }
    }
    for (const [name, e] of this.#byMcp) fp.push([name, e.description, canonicalJson(e.inputSchema)]);
    this.fingerprint = sha(canonicalJson(fp));
  }

  #add(entry) {
    // The same declaration twice (same kind, namespace and name): keep the first.
    if (this.#byMcp.has(entry.mcpName)) {
      this.skipped += 1;
      return;
    }
    this.#byMcp.set(entry.mcpName, entry);
  }

  #addFunction(tool, ns, maxChars) {
    if (typeof tool.name !== 'string' || !tool.name) throw bridgeError('bad_request', { where: 'function_name' });
    const namespace = ns?.name ?? null;
    const inputSchema = normalizeParameters(tool.parameters);
    const nsDesc = ns && typeof ns.description === 'string' && ns.description ? `[${namespace}] ${ns.description}\n\n` : '';
    this.#add({
      kind: 'function',
      name: tool.name,
      namespace,
      mcpName: opaqueName('function', namespace, tool.name),
      title: namespace ? `${namespace}.${tool.name}` : tool.name,
      description: `${nsDesc}${typeof tool.description === 'string' ? tool.description : ''}`.slice(0, maxChars),
      inputSchema,
      validator: null,
    });
  }

  #addCustom(tool, ns, maxChars) {
    if (typeof tool.name !== 'string' || !tool.name) throw bridgeError('bad_request', { where: 'custom_name' });
    const namespace = ns?.name ?? null;
    this.#add({
      kind: 'custom',
      name: tool.name,
      namespace,
      mcpName: opaqueName('custom', namespace, tool.name),
      title: namespace ? `${namespace}.${tool.name}` : tool.name,
      description: describeCustom(tool).slice(0, maxChars),
      inputSchema: CUSTOM_SCHEMA,
      validator: null,
    });
  }

  get size() {
    return this.#byMcp.size;
  }

  /** MCP `tools/list` payload. */
  list() {
    return [...this.#byMcp.values()].map((e) => ({
      name: e.mcpName,
      title: e.title,
      description: e.description,
      inputSchema: e.inputSchema,
    }));
  }

  resolve(mcpName) {
    return this.#byMcp.get(mcpName) ?? null;
  }

  /** null when valid, else a short schema-derived reason (no argument values). */
  validate(entry, args) {
    if (!entry.validator) entry.validator = compileValidator(entry.inputSchema);
    return entry.validator(args);
  }
}

export function newCallId() {
  return `call_${randomBytes(12).toString('hex')}`;
}

/** The Responses output item Codex receives for an accepted MCP call. */
export function callItem(entry, callId, args) {
  if (entry.kind === 'custom') {
    const item = { type: 'custom_tool_call', id: `ctc_${randomBytes(12).toString('hex')}`, status: 'completed', call_id: callId, name: entry.name, input: args.input };
    if (entry.namespace) item.namespace = entry.namespace;
    return item;
  }
  const item = { type: 'function_call', id: `fc_${randomBytes(12).toString('hex')}`, status: 'completed', call_id: callId, name: entry.name, arguments: JSON.stringify(args) };
  if (entry.namespace) item.namespace = entry.namespace;
  return item;
}
