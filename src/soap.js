// Just enough SOAP 1.1 for an RPC/encoded service, which is what
// RadioReference's database API is (NuSOAP on their side): the envelope for one
// call, and its reply turned into plain values. Written here rather than added
// as a dependency, because the replies are small and machine-made and the
// project otherwise needs only express.

const ENCODING = 'http://schemas.xmlsoap.org/soap/encoding/';

/** A fault the service answered with: a code such as AUTH, and its message. */
export class SoapFault extends Error {
  /**
   * @param {string} code - faultcode.
   * @param {string} message - faultstring.
   */
  constructor(code, message) {
    super(message);
    this.name = 'SoapFault';
    this.code = code;
  }
}

const ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ESCAPES[c]);

/** Typed parameters, as an RPC/encoded call sends them. */
export const xsd = {
  int: (v) => ({ type: 'xsd:int', value: v }),
  decimal: (v) => ({ type: 'xsd:decimal', value: v }),
  string: (v) => ({ type: 'xsd:string', value: v }),
};

/**
 * @param {string} type - Its type, in the service's namespace (ns1:...).
 * @param {Record<string, object>} fields - Each a typed parameter.
 * @returns {object} A struct parameter.
 */
export const struct = (type, fields) => ({ type, fields });

function encode(name, p) {
  const inner = p.fields
    ? Object.entries(p.fields).map(([k, f]) => encode(k, f)).join('')
    : escapeXml(p.value ?? '');
  return `<${name} xsi:type="${p.type}">${inner}</${name}>`;
}

/**
 * The request for one call.
 * @param {string} ns - The service's namespace.
 * @param {string} method - The operation.
 * @param {Record<string, object>} params - In the order the operation takes them.
 * @returns {string} The envelope.
 */
export function envelope(ns, method, params) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
    ` xmlns:SOAP-ENC="${ENCODING}" xmlns:ns1="${escapeXml(ns)}" SOAP-ENV:encodingStyle="${ENCODING}">` +
    `<SOAP-ENV:Body><ns1:${method}>` +
    Object.entries(params).map(([k, p]) => encode(k, p)).join('') +
    `</ns1:${method}></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== '#') return ENTITIES[e] ?? all;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

// One token at a time, from where the last ended: a comment, CDATA, a
// declaration or doctype, an end tag, a start tag (with attributes), or text
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parse a well-formed document into elements: {name, attrs, kids, text}.
 * @param {string} xml - The document.
 * @returns {{name: string, attrs: object, kids: object[], text: string}} A root holding the document element.
 */
export function parseXml(xml) {
  const root = { name: '#document', attrs: {}, kids: [], text: '' };
  const stack = [root];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < xml.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(xml);
    if (!m) throw new Error(`not XML at character ${at}`);
    const top = stack.at(-1);
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[2]) {
      if (stack.length < 2 || top.name !== m[2]) throw new Error(`</${m[2]}> closes nothing open`);
      stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of (m[4] ?? '').matchAll(ATTR)) attrs[a[1]] = unescapeXml(a[2] ?? a[3]);
      const node = { name: m[3], attrs, kids: [], text: '' };
      top.kids.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      top.text += unescapeXml(m[6]);
    }
  }
  if (stack.length !== 1) throw new Error(`<${stack.at(-1).name}> is never closed`);
  return root;
}

const local = (name) => name.slice(name.indexOf(':') + 1);
function attr(node, name) {
  for (const [k, v] of Object.entries(node.attrs)) if (local(k) === name) return v;
  return undefined;
}

const NUMBERS = new Set(['int', 'integer', 'long', 'short', 'byte', 'decimal', 'double', 'float',
  'unsignedInt', 'unsignedLong', 'unsignedShort', 'nonNegativeInteger', 'positiveInteger']);

/**
 * A SOAP-encoded value as a plain one: an array for SOAP-ENC:Array, an object
 * for a struct, a number or boolean where its xsi:type says, a string otherwise.
 * An empty struct or array without a type marking it one is ''; callers that
 * expect a list use `list()`.
 * @param {object} node - An element from parseXml.
 * @returns {unknown} Its value.
 */
export function decode(node) {
  const nil = attr(node, 'nil');
  if (nil === 'true' || nil === '1') return null;
  const type = attr(node, 'type') ?? '';
  if (attr(node, 'arrayType') !== undefined || local(type) === 'Array') return node.kids.map(decode);
  if (node.kids.length) {
    const out = {};
    const repeated = new Map();
    for (const kid of node.kids) {
      const key = local(kid.name);
      if (key === '__proto__') continue;
      const value = decode(kid);
      if (!Object.hasOwn(out, key)) out[key] = value;
      else {
        if (!repeated.has(key)) repeated.set(key, [out[key]]);
        repeated.get(key).push(value);
        out[key] = repeated.get(key);
      }
    }
    return out;
  }
  const text = node.text;
  if (NUMBERS.has(local(type))) {
    if (!text.trim()) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (local(type) === 'boolean') return text.trim() === 'true' || text.trim() === '1';
  return text;
}

/**
 * @param {unknown} v - A decoded value that should be a list.
 * @returns {any[]} It, or the one value in it, or nothing.
 */
export const list = (v) => (Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v]);

/**
 * The reply's text, in the encoding its declaration names. NuSOAP has been
 * known to declare UTF-8 over Latin-1 bytes, so UTF-8 that doesn't decode is
 * read as Latin-1 rather than mangled.
 * @param {Buffer} buf - The body.
 * @returns {string} Its text.
 */
function bodyText(buf) {
  const declared = /encoding\s*=\s*["']([^"']+)/i.exec(buf.subarray(0, 120).toString('latin1'))?.[1] ?? 'utf-8';
  if (/8859-1|latin-?1|1252/i.test(declared)) return buf.toString('latin1');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/**
 * Make one call.
 * @param {object} o - The call.
 * @param {string} o.endpoint - Where to POST it.
 * @param {string} o.ns - The service's namespace; the SOAPAction is ns#method.
 * @param {string} o.method - The operation.
 * @param {Record<string, object>} o.params - Typed parameters (xsd.*, struct()).
 * @param {typeof fetch} [o.fetch] - For tests.
 * @param {number} [o.timeoutMs] - How long to wait for the reply.
 * @param {string} [o.userAgent] - Who is asking.
 * @returns {Promise<unknown>} The decoded return value.
 * @throws {SoapFault} When the service answers with a fault.
 */
export async function call({ endpoint, ns, method, params, fetch = globalThis.fetch, timeoutMs = 20000, userAgent }) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"${ns}#${method}"`,
      ...(userAgent ? { 'User-Agent': userAgent } : {}),
    },
    body: envelope(ns, method, params),
    redirect: 'error',   // a sign-in sent on to somewhere else isn't followed
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = bodyText(Buffer.from(await res.arrayBuffer()));
  let doc;
  try {
    doc = parseXml(text);
  } catch {
    throw new Error(`HTTP ${res.status}, and not a SOAP reply`);
  }
  const env = doc.kids.find((k) => local(k.name) === 'Envelope');
  const body = env?.kids.find((k) => local(k.name) === 'Body');
  if (!body) throw new Error(`HTTP ${res.status}, and not a SOAP reply`);
  const fault = body.kids.find((k) => local(k.name) === 'Fault');
  if (fault) {
    const f = decode(fault);
    throw new SoapFault(String(f?.faultcode ?? ''), String(f?.faultstring || 'the service reported a fault'));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ret = body.kids[0]?.kids[0];   // <ns1:methodResponse><return>
  return ret ? decode(ret) : null;
}
