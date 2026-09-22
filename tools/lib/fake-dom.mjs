// A small DOM for Node contract tests: elements, attributes, dataset, classList,
// bubbling events, focus, <dialog>, and a CSS selector subset (tag, #id, .class,
// [attr], [attr=v], [attr~=v], [attr^=v], [attr*=v], :not(), descendant and child
// combinators, selector lists). Layout is not modelled.

const camelToData = name => `data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
const dataToCamel = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; this.immediateStopped = true; }
}

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler, options = {}) {
    if (!handler) return;
    const list = this.listeners.get(type) || [];
    if (list.some(entry => entry.handler === handler)) return;
    const entry = { handler, once: typeof options === 'object' && options.once };
    list.push(entry);
    this.listeners.set(type, list);
    options?.signal?.addEventListener?.('abort', () => this.removeEventListener(type, handler));
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.handler !== handler));
  }
  invoke(event) {
    for (const entry of [...(this.listeners.get(event.type) || [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.handler);
      event.currentTarget = this;
      if (typeof entry.handler === 'function') entry.handler.call(this, event);
      else entry.handler.handleEvent?.(event);
      if (event.immediateStopped) break;
    }
  }
  dispatchEvent(input) {
    const event = input instanceof FakeEvent ? input : Object.assign(new FakeEvent(input.type, { bubbles: input.bubbles }), { detail: input.detail });
    event.target ??= this;
    let node = this;
    while (node) {
      node.invoke(event);
      if (event.propagationStopped || !event.bubbles) break;
      node = node.parentNode || (node.nodeType === 9 ? node.defaultView : null);
    }
    return !event.defaultPrevented;
  }
}

// ---------- selectors ----------
function parseSelectorList(text) {
  const list = [];
  let depth = 0, quote = null, start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === ',' && depth === 0) { list.push(text.slice(start, at)); start = at + 1; }
  }
  list.push(text.slice(start));
  return list.map(part => parseComplex(part.trim()));
}

function parseComplex(text) {
  // Returns [{compound, combinator}] left to right; combinator joins to the previous part.
  const parts = [];
  let at = 0, combinator = null;
  while (at < text.length) {
    while (text[at] === ' ') { at++; combinator ||= ' '; }
    if (text[at] === '>') { combinator = '>'; at++; while (text[at] === ' ') at++; continue; }
    const [compound, end] = parseCompound(text, at);
    parts.push({ compound, combinator: parts.length ? combinator || ' ' : null });
    combinator = null;
    at = end;
  }
  return parts;
}

function parseCompound(text, at) {
  const simple = [];
  const ident = () => { const match = /^[-\w -￿\\]+/.exec(text.slice(at)); if (!match) throw new Error(`Bad selector: ${text}`); at += match[0].length; return match[0]; };
  while (at < text.length && text[at] !== ' ' && text[at] !== '>') {
    const char = text[at];
    if (char === '*') { at++; continue; }
    if (char === '#') { at++; simple.push({ type: 'id', value: ident() }); }
    else if (char === '.') { at++; simple.push({ type: 'class', value: ident() }); }
    else if (char === '[') {
      at++;
      const name = ident().toLowerCase();
      let op = null, value = null;
      const opMatch = /^([~^$*|]?=)/.exec(text.slice(at));
      if (opMatch) {
        op = opMatch[1]; at += op.length;
        if (text[at] === '"' || text[at] === "'") {
          const quote = text[at++]; const end = text.indexOf(quote, at);
          value = text.slice(at, end); at = end + 1;
        } else { const end = text.indexOf(']', at); value = text.slice(at, end).trim(); at = end; }
      }
      while (text[at] !== ']') at++;
      at++;
      simple.push({ type: 'attr', name, op, value });
    } else if (char === ':') {
      at++;
      const name = ident();
      if (text[at] === '(') {
        let depth = 1, end = at + 1;
        while (depth) { if (text[end] === '(') depth++; else if (text[end] === ')') depth--; end++; }
        const inner = text.slice(at + 1, end - 1);
        at = end;
        simple.push({ type: 'pseudo', name, list: parseSelectorList(inner) });
      } else simple.push({ type: 'pseudo', name });
    } else simple.push({ type: 'tag', value: ident().toLowerCase() });
  }
  return [simple, at];
}

function matchSimple(element, simple) {
  switch (simple.type) {
    case 'tag': return element.localName === simple.value;
    case 'id': return element.getAttribute('id') === simple.value;
    case 'class': return element.classList.contains(simple.value);
    case 'attr': {
      const value = element.getAttribute(simple.name);
      if (value === null) return false;
      if (!simple.op) return true;
      if (simple.op === '=') return value === simple.value;
      if (simple.op === '~=') return value.split(/\s+/).includes(simple.value);
      if (simple.op === '^=') return value.startsWith(simple.value);
      if (simple.op === '$=') return value.endsWith(simple.value);
      if (simple.op === '*=') return value.includes(simple.value);
      if (simple.op === '|=') return value === simple.value || value.startsWith(`${simple.value}-`);
      return false;
    }
    case 'pseudo':
      if (simple.name === 'not') return !simple.list.some(complex => matchComplex(element, complex));
      if (simple.name === 'is' || simple.name === 'where') return simple.list.some(complex => matchComplex(element, complex));
      if (simple.name === 'focus' || simple.name === 'focus-visible') return element.ownerDocument.activeElement === element;
      if (simple.name === 'checked') return !!element.checked;
      if (simple.name === 'disabled') return element.hasAttribute('disabled');
      if (simple.name === 'first-child') return element.parentNode?.children[0] === element;
      if (simple.name === 'last-child') return element.parentNode?.children.at(-1) === element;
      throw new Error(`Unsupported pseudo-class :${simple.name}`);
    default: return false;
  }
}

const matchCompound = (element, compound) => compound.every(simple => matchSimple(element, simple));

function matchComplex(element, parts, index = parts.length - 1) {
  if (!matchCompound(element, parts[index].compound)) return false;
  if (index === 0) return true;
  const combinator = parts[index].combinator;
  let parent = element.parentElement;
  if (combinator === '>') return !!parent && matchComplex(parent, parts, index - 1);
  while (parent) {
    if (matchComplex(parent, parts, index - 1)) return true;
    parent = parent.parentElement;
  }
  return false;
}

const cache = new Map();
function compiled(selector) {
  if (!cache.has(selector)) cache.set(selector, parseSelectorList(selector));
  return cache.get(selector);
}

// ---------- nodes ----------
class FakeNode extends Target {
  constructor(document) { super(); this.ownerDocument = document; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() {
    let node = this;
    while (node) { if (node.nodeType === 9) return true; node = node.parentNode; }
    return false;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get nextSibling() { const siblings = this.parentNode?.childNodes || []; return siblings[siblings.indexOf(this) + 1] || null; }
  get previousSibling() { const siblings = this.parentNode?.childNodes || []; return siblings[siblings.indexOf(this) - 1] || null; }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) {
    this.replaceChildren();
    const text = value === null || value === undefined ? '' : String(value);
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }
  adopt(child) {
    if (typeof child === 'string' || typeof child === 'number') return this.ownerDocument.createTextNode(String(child));
    if (child.nodeType === 11) return child;
    child.remove();
    return child;
  }
  insertBefore(child, reference) {
    const node = this.adopt(child);
    const nodes = node.nodeType === 11 ? node.childNodes.splice(0) : [node];
    const at = reference ? this.childNodes.indexOf(reference) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, ...nodes);
    for (const each of nodes) each.parentNode = this;
    return child;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  append(...children) { for (const child of children) this.appendChild(child); }
  prepend(...children) { const first = this.firstChild; for (const child of children) this.insertBefore(child, first); }
  removeChild(child) { child.remove(); return child; }
  replaceChildren(...children) {
    for (const child of [...this.childNodes]) child.remove();
    this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    const document = this.ownerDocument;
    if (document?.activeElement && (document.activeElement === this || this.contains?.(document.activeElement))) document.activeElement = document.body;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  before(...nodes) { for (const node of nodes) this.parentNode.insertBefore(node, this); }
  after(...nodes) { const next = this.nextSibling; for (const node of nodes) this.parentNode.insertBefore(node, next); }
  replaceWith(...nodes) { this.before(...nodes); this.remove(); }
  contains(node) { while (node) { if (node === this) return true; node = node.parentNode; } return false; }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get childElementCount() { return this.children.length; }
  *descendants() {
    for (const child of this.childNodes) {
      if (child.nodeType !== 1) continue;
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector) {
    const list = compiled(selector);
    return [...this.descendants()].filter(element => list.some(complex => matchComplex(element, complex)));
  }
  querySelector(selector) {
    const list = compiled(selector);
    for (const element of this.descendants()) if (list.some(complex => matchComplex(element, complex))) return element;
    return null;
  }
  getElementById(id) {
    for (const element of this.descendants()) if (element.getAttribute('id') === id) return element;
    return null;
  }
}

class FakeText extends FakeNode {
  constructor(document, text) { super(document); this.nodeType = 3; this.data = text; }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  get nodeValue() { return this.data; }
}

class FakeFragment extends FakeNode { constructor(document) { super(document); this.nodeType = 11; } }

class ClassList {
  constructor(element) { this.element = element; }
  get tokens() { return (this.element.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  set tokens(list) { this.element.setAttribute('class', [...new Set(list)].join(' ')); }
  contains(token) { return this.tokens.includes(token); }
  add(...tokens) { this.tokens = [...this.tokens, ...tokens]; }
  remove(...tokens) { this.tokens = this.tokens.filter(token => !tokens.includes(token)); }
  toggle(token, force) {
    const on = force === undefined ? !this.contains(token) : !!force;
    if (on) this.add(token); else this.remove(token);
    return on;
  }
  get length() { return this.tokens.length; }
  [Symbol.iterator]() { return this.tokens[Symbol.iterator](); }
}

class Style {
  constructor() { this.props = new Map(); }
  setProperty(name, value) { this.props.set(name, String(value)); }
  getPropertyValue(name) { return this.props.get(name) || ''; }
  removeProperty(name) { this.props.delete(name); }
}

const BOOLEAN_ATTRS = ['hidden', 'disabled', 'checked', 'open', 'selected', 'readonly', 'required', 'inert'];
const STRING_ATTRS = { id: 'id', type: 'type', title: 'title', htmlFor: 'for', name: 'name', role: 'role', src: 'src', alt: 'alt',
  min: 'min', max: 'max', step: 'step', placeholder: 'placeholder', lang: 'lang', href: 'href', draggable: 'draggable' };

class FakeElement extends FakeNode {
  constructor(document, tag, namespace = null) {
    super(document);
    this.nodeType = 1;
    this.localName = namespace ? tag : tag.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.namespaceURI = namespace;
    this.attrs = new Map();
    this.style = new Style();
    this.classList = new ClassList(this);
    this.dataset = new Proxy({}, {
      get: (_, key) => typeof key === 'string' ? this.getAttribute(camelToData(key)) ?? undefined : undefined,
      set: (_, key, value) => { this.setAttribute(camelToData(key), value); return true; },
      deleteProperty: (_, key) => { this.removeAttribute(camelToData(key)); return true; },
      has: (_, key) => this.hasAttribute(camelToData(key)),
      ownKeys: () => [...this.attrs.keys()].filter(name => name.startsWith('data-')).map(dataToCamel),
      getOwnPropertyDescriptor: (_, key) => this.hasAttribute(camelToData(key))
        ? { enumerable: true, configurable: true, value: this.getAttribute(camelToData(key)) } : undefined,
    });
    if (this.localName === 'input' || this.localName === 'select' || this.localName === 'textarea' || this.localName === 'output') this._value = '';
    this.scrollTop = 0; this.scrollLeft = 0;
  }
  getAttribute(name) { return this.attrs.has(name.toLowerCase()) ? this.attrs.get(name.toLowerCase()) : null; }
  setAttribute(name, value) { this.attrs.set(name.toLowerCase(), String(value)); }
  removeAttribute(name) { this.attrs.delete(name.toLowerCase()); }
  hasAttribute(name) { return this.attrs.has(name.toLowerCase()); }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : !!force;
    if (on) this.setAttribute(name, ''); else this.removeAttribute(name);
    return on;
  }
  getAttributeNames() { return [...this.attrs.keys()]; }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get tabIndex() {
    const value = this.getAttribute('tabindex');
    if (value !== null) return Number(value);
    return ['button', 'input', 'select', 'textarea', 'a', 'summary'].includes(this.localName) ? 0 : -1;
  }
  set tabIndex(value) { this.setAttribute('tabindex', value); }
  get value() {
    if (this.localName === 'select') return this._value || this.querySelector('option')?.value || '';
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(value) { this._value = String(value); }
  get innerHTML() { throw new Error('fake-dom: innerHTML is not supported; build nodes explicitly'); }
  set innerHTML(value) { if (value === '') this.replaceChildren(); else throw new Error('fake-dom: innerHTML is not supported'); }
  matches(selector) { return compiled(selector).some(complex => matchComplex(this, complex)); }
  closest(selector) {
    let node = this;
    while (node?.nodeType === 1) { if (node.matches(selector)) return node; node = node.parentNode; }
    return null;
  }
  focus() {
    const document = this.ownerDocument;
    if (!this.isConnected || document.activeElement === this) return;
    const previous = document.activeElement;
    document.activeElement = this;
    previous?.dispatchEvent?.(new FakeEvent('blur', { bubbles: false, relatedTarget: this }));
    previous?.dispatchEvent?.(new FakeEvent('focusout', { relatedTarget: this }));
    this.dispatchEvent(new FakeEvent('focus', { bubbles: false }));
    this.dispatchEvent(new FakeEvent('focusin', { relatedTarget: previous }));
  }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.body.focus(); }
  click() {
    if (this.hasAttribute('disabled')) return;
    this.dispatchEvent(new FakeEvent('click', { button: 0 }));
  }
  scrollIntoView() { this.ownerDocument.scrolledIntoView = this; }
  scrollTo() {}
  getClientRects() { return this.isConnected && !this.closest('[hidden]') ? [{ width: 1, height: 1 }] : []; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  get offsetParent() { return this.getClientRects().length ? this.parentElement : null; }
  get clientWidth() { return 0; }
  get scrollWidth() { return 0; }
  setPointerCapture() {}
  releasePointerCapture() {}
  // <dialog>
  showModal() {
    if (this.hasAttribute('open')) throw new Error('InvalidStateError: dialog already open');
    this.setAttribute('open', '');
  }
  show() { this.setAttribute('open', ''); }
  close(value) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    if (value !== undefined) this.returnValue = value;
    this.dispatchEvent(new FakeEvent('close', { bubbles: false }));
  }
}
for (const name of BOOLEAN_ATTRS) {
  Object.defineProperty(FakeElement.prototype, name, {
    get() { return this.hasAttribute(name); },
    set(value) { this.toggleAttribute(name, !!value); },
  });
}
for (const [property, attribute] of Object.entries(STRING_ATTRS)) {
  Object.defineProperty(FakeElement.prototype, property, {
    get() { return this.getAttribute(attribute) ?? ''; },
    set(value) { this.setAttribute(attribute, value); },
  });
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.hidden = false;
    this.visibilityState = 'visible';
    this.documentElement = this.createElement('html');
    this.appendChild(this.documentElement);
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(namespace, tag) { return new FakeElement(this, tag, namespace); }
  createTextNode(text) { return new FakeText(this, text); }
  createDocumentFragment() { return new FakeFragment(this); }
}

class FakeWindow extends Target {
  constructor(document) {
    super();
    this.document = document;
    document.defaultView = this;
    this.devicePixelRatio = 1;
    this.innerWidth = 1440;
    this.innerHeight = 900;
  }
  matchMedia(query) {
    const width = this.innerWidth;
    const test = (clause) => {
      const max = /max-width:\s*(\d+)px/.exec(clause), min = /min-width:\s*(\d+)px/.exec(clause);
      if (/prefers-reduced-motion/.test(clause)) return false;
      return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
    };
    return { matches: test(query), media: query, addEventListener() {}, removeEventListener() {} };
  }
  getComputedStyle(element) { return { getPropertyValue: name => element.style.getPropertyValue(name), display: element.hidden ? 'none' : 'block' }; }
}

/** Install a fresh document and window on globalThis; returns them plus `restore()`. */
export function installFakeDom({ width = 1440, storage = true } = {}) {
  const names = ['document', 'window', 'CustomEvent', 'Event', 'KeyboardEvent', 'MutationObserver', 'HTMLElement', 'localStorage',
    'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia'];
  const saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const document = new FakeDocument();
  const window = new FakeWindow(document);
  window.innerWidth = width;
  const store = new Map();
  const localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: index => [...store.keys()][index] ?? null,
  };
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define('document', document);
  define('window', window);
  define('CustomEvent', class extends FakeEvent { constructor(type, init = {}) { super(type, { bubbles: false, ...init }); this.detail = init.detail ?? null; } });
  define('Event', FakeEvent);
  define('KeyboardEvent', FakeEvent);
  define('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return []; } });
  define('HTMLElement', FakeElement);
  define('requestAnimationFrame', callback => setTimeout(() => callback(Date.now()), 0));
  define('cancelAnimationFrame', id => clearTimeout(id));
  define('getComputedStyle', element => window.getComputedStyle(element));
  define('matchMedia', query => window.matchMedia(query));
  if (storage) define('localStorage', localStorage);
  else Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError: storage disabled'); }, configurable: true });
  window.localStorage = storage ? localStorage : undefined;
  window.CustomEvent = globalThis.CustomEvent;
  return {
    document, window, localStorage, store,
    restore() {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

/** Dispatch a bubbling event with extra fields, e.g. `fire(el, 'keydown', { key: 'ArrowRight' })`. */
export function fire(target, type, init = {}) {
  const event = new FakeEvent(type, init);
  target.dispatchEvent(event);
  return event;
}

export { FakeEvent, FakeElement, FakeDocument };
