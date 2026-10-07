/**
 * Just enough DOM for the Conquest HUD suites in Node: elements and SVG nodes
 * with classes, datasets, styles, attributes, listeners and a selector matcher
 * (`tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`, compounds and descendant
 * chains), plus 2D canvas contexts that record every call so map and reticle
 * painting can be asserted without a browser.
 */
import { installGlobals } from './install-globals.mjs';

/** A 2D context stand-in: property writes are kept, every method call is logged. */
export function recordingContext(canvas) {
  const calls = [];
  const state = { canvas, calls, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif', globalAlpha: 1 };
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return text => ({ width: String(text).length * 6 });
      if (key === 'getLineDash') return () => [];
      return (...args) => { calls.push([key, ...args]); };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

class FakeStyle {
  constructor() { this._props = new Map(); }
  setProperty(name, value) { this._props.set(name, String(value)); }
  getPropertyValue(name) { return this._props.get(name) ?? ''; }
  removeProperty(name) { this._props.delete(name); }
}

let documentRef = null;

export class FakeNode {
  constructor(tagName, namespaceURI = null) {
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName);
    this.namespaceURI = namespaceURI;
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = new FakeStyle();
    this.listeners = new Map();
    this.classes = new Set();
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.title = '';
    this.id = '';
    this._text = '';
    this.width = 0;
    this.height = 0;
    this._context = null;
    this.ownerDocument = documentRef;
    const classes = this.classes;
    this.classList = {
      add: (...names) => names.forEach(n => classes.add(n)),
      remove: (...names) => names.forEach(n => classes.delete(n)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    };
  }

  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes.clear(); String(value ?? '').split(/\s+/).filter(Boolean).forEach(c => this.classes.add(c)); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get firstElementChild() { return this.children.find(c => c.nodeType === 1) ?? null; }
  get lastElementChild() { return this.children.findLast(c => c.nodeType === 1) ?? null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === documentRef?.documentElement; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value ?? '');
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(value) { this.textContent = String(value ?? '').replace(/<[^>]*>/g, ''); }
  get offsetWidth() { return 0; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }

  setAttribute(name, value) {
    const v = String(value);
    if (name === 'class') this.className = v;
    else if (name === 'id') this.id = v;
    else if (name === 'hidden') this.hidden = true;
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    this.attributes.set(name, v);
  }
  getAttribute(name) {
    if (name === 'class') return this.className || null;
    if (name === 'id') return this.id || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { if (name === 'hidden') this.hidden = false; this.attributes.delete(name); }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { nodes.forEach(n => this.appendChild(typeof n === 'string' ? Object.assign(new FakeNode('#text'), { _text: n }) : n)); }
  prepend(...nodes) { for (const n of nodes.reverse()) { n.parentNode?.removeChild(n); n.parentNode = this; this.children.unshift(n); } }
  insertBefore(child, ref) {
    child.parentNode?.removeChild(child);
    const index = ref ? this.children.indexOf(ref) : -1;
    child.parentNode = this;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }
  removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; }
  replaceChildren(...nodes) { this.textContent = ''; nodes.forEach(n => this.appendChild(n)); }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }

  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) {
    event.target ??= this;
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    event.stopPropagation ??= () => {};
    for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event);
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click', target: this }); }
  focus() { if (documentRef) documentRef.activeElement = this; }
  blur() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  getContext(kind) {
    if (this.tagName !== 'CANVAS' || kind !== '2d') return null;
    this._context ??= recordingContext(this);
    return this._context;
  }

  matches(selector) { return selector.split(',').some(part => matchChain(this, part.trim().split(/\s+/))); }
  closest(selector) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches?.(selector)) return n; return null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = node => { for (const c of node.children) { if (c.nodeType === 1 && c.matches(selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function matchSimple(node, simple) {
  const re = /([.#]?[\w-]+)|\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g;
  let m, any = false;
  while ((m = re.exec(simple))) {
    any = true;
    if (m[1]) {
      const token = m[1];
      if (token.startsWith('.')) { if (!node.classes?.has(token.slice(1))) return false; }
      else if (token.startsWith('#')) { if (node.id !== token.slice(1)) return false; }
      else if (node.localName?.toLowerCase() !== token.toLowerCase()) return false;
    } else {
      const name = m[2], expected = m[3];
      let actual;
      if (name === 'hidden') actual = node.hidden ? '' : null;
      else if (name.startsWith('data-')) actual = node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
      else actual = node.getAttribute(name);
      if (actual === null || actual === undefined) return false;
      if (expected !== undefined && String(actual) !== expected) return false;
    }
  }
  return any;
}

function matchChain(node, parts) {
  if (!parts.length || !matchSimple(node, parts.at(-1))) return false;
  let rest = parts.slice(0, -1);
  for (let n = node.parentNode; rest.length && n && n.nodeType === 1; n = n.parentNode) {
    if (matchSimple(n, rest.at(-1))) rest = rest.slice(0, -1);
  }
  return rest.length === 0;
}

/** A visible-for-real check: the node and every ancestor are not hidden. */
export function isShown(node) {
  for (let n = node; n && n.nodeType === 1; n = n.parentNode) if (n.hidden) return false;
  return true;
}

/** Collect canvas fillText strings drawn on a context. */
export const textsDrawn = context => (context?.calls || []).filter(c => c[0] === 'fillText').map(c => String(c[1]));

/**
 * Install document / window / storage / animation-frame globals. Returns
 * `{ document, window, storage, restore }`.
 */
export function installFakeDom({ width = 1440, height = 900 } = {}) {
  const listeners = new Map();
  const window = {
    innerWidth: width, innerHeight: height, devicePixelRatio: 1,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); return true; },
    listenerCount: type => listeners.get(type)?.size ?? 0,
  };
  const doc = {
    nodeType: 9,
    activeElement: null,
    hidden: false,
    defaultView: window,
    createElement: tag => new FakeNode(tag),
    createElementNS: (ns, tag) => new FakeNode(tag, ns),
    createTextNode: text => Object.assign(new FakeNode('#text'), { nodeType: 3, _text: String(text) }),
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
    querySelector: selector => doc.documentElement.querySelector(selector),
    querySelectorAll: selector => doc.documentElement.querySelectorAll(selector),
    getElementById: id => doc.documentElement.querySelector(`#${id}`),
  };
  documentRef = doc;
  doc.documentElement = new FakeNode('html');
  doc.head = doc.documentElement.appendChild(new FakeNode('head'));
  doc.body = doc.documentElement.appendChild(new FakeNode('body'));
  const store = new Map();
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    clear: () => store.clear(),
  };
  class CustomEventShim { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  const restore = installGlobals({
    document: doc, window, localStorage: storage, innerWidth: width, innerHeight: height, devicePixelRatio: 1,
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0), cancelAnimationFrame: id => clearTimeout(id),
    CustomEvent: globalThis.CustomEvent ?? CustomEventShim,
  });
  return { document: doc, window, storage, restore };
}
