// DOM renderer for Juris: elements, seats, keyed reconcile, components on nodes, enhance.
// It owns every node-keyed registry; state, components and the api come from the Juris core it is given.
import { FallbackSignal } from "./errors.js";
import { checkAttribute, checkInnerHTML, checkStyle, checkTag, classTokens, reusableElement } from "./html-safety.js";

// What a layout draws inside an element: a reused element that held any of these, under a layout
// that names none, is emptied (updateElement, F27).
const INNER = ["children", "textContent", "innerHTML"];

const BOOLEAN_ATTRIBUTES = new Set([
    "allowfullscreen",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "controls",
    "default",
    "defer",
    "disabled",
    "formnovalidate",
    "hidden",
    "inert",
    "ismap",
    "itemscope",
    "loop",
    "multiple",
    "muted",
    "nomodule",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "reversed",
    "selected",
]);
const ATTRIBUTE_ALIASES = {
    className: "class",
    htmlFor: "for",
};
const NAMESPACES = {
    math: "http://www.w3.org/1998/Math/MathML",
    svg: "http://www.w3.org/2000/svg",
};
// Where the browser's HTML parser reads a tag as HTML again inside <svg> or <math> (its integration
// points), so where the server's markup holds HTML: inside SVG's foreignObject, desc and title;
// inside MathML's mi, mo, mn, ms and mtext, but for mglyph and malignmark, which stay MathML; and
// inside an annotation-xml whose encoding is text/html or application/xhtml+xml, in any case. An
// annotation-xml of another encoding holds MathML, but for an <svg>, which is SVG. The client drew
// all of these in the parent's namespace but foreignObject's, so a page changed at hydration.
// ssr-renderer.js keeps the same rule; the browser suite holds the two to the parser.
const HTML_INSIDE_SVG = new Set(["foreignobject", "desc", "title"]);
const TEXT_INSIDE_MATH = new Set(["mi", "mo", "mn", "ms", "mtext"]);
const HTML_ENCODINGS = new Set(["text/html", "application/xhtml+xml"]);
// What is drawn inside a MathML token element, and inside an annotation-xml that holds no HTML:
// contexts no namespace says alone. Internal: passed down where a namespace is, and read only by
// elementNamespace (and never by a caller's `namespace`, which is a namespace or null).
const IN_MATH_TEXT = Symbol("inside a MathML token element");
const IN_ANNOTATION = Symbol("inside an annotation-xml of no HTML encoding");
// The namespace of an element named `lowerTag` drawn where `inherited` says.
const elementNamespace = (inherited, lowerTag) => {
    if (inherited === IN_MATH_TEXT) return lowerTag === "mglyph" || lowerTag === "malignmark" ? NAMESPACES.math : NAMESPACES[lowerTag] ?? null;
    if (inherited === IN_ANNOTATION) return lowerTag === "svg" ? NAMESPACES.svg : NAMESPACES.math;
    return inherited || NAMESPACES[lowerTag] || null;
};
// What an element drawn in `namespace` holds: its own namespace, but at an integration point.
const namespaceInside = (namespace, lowerTag, encoding) => {
    if (namespace === NAMESPACES.svg) return HTML_INSIDE_SVG.has(lowerTag) ? null : namespace;
    if (namespace === NAMESPACES.math) {
        if (TEXT_INSIDE_MATH.has(lowerTag)) return IN_MATH_TEXT;
        if (lowerTag === "annotation-xml") return HTML_ENCODINGS.has(String(encoding ?? "").toLowerCase()) ? null : IN_ANNOTATION;
    }
    return namespace;
};
// The namespaces the HTML parser gives a prefixed attribute on an SVG or MathML element (its
// "adjust foreign attributes" step): `xlink:href` in the XLink namespace, `xml:lang` in XML's,
// `xmlns` and `xmlns:…` in XMLNS's. setAttribute made each a plain attribute of that name, which a
// browser ignores (a <use xlink:href> drew nothing), where the server's markup, parsed, gave the
// real one. On an HTML element the parser keeps a plain attribute, and so does this.
const ATTRIBUTE_NAMESPACES = {
    xlink: "http://www.w3.org/1999/xlink",
    xml: "http://www.w3.org/XML/1998/namespace",
    xmlns: "http://www.w3.org/2000/xmlns/",
};
const attributeNamespace = (element, name) => {
    if (element.namespaceURI !== NAMESPACES.svg && element.namespaceURI !== NAMESPACES.math) return null;
    const colon = name.indexOf(":");
    return ATTRIBUTE_NAMESPACES[colon === -1 ? (name === "xmlns" ? name : "") : name.slice(0, colon)] ?? null;
};

// Whether a capitalised tag drawn where `inherited` says is an element of <svg> or <math> (never an
// unknown component, Juris.unknownComponent), which it is not at an HTML integration point.
const foreignContext = (inherited) => (inherited === IN_MATH_TEXT ? null : inherited);

// Handle returned by enhance(): the matched elements (live under observe) and a way to undo it all.
class Enhancement {
    constructor(elements, dispose) {
        this.elements = elements;
        this.disposed = false;
        this.dispose = () => {
            if (this.disposed) return;
            this.disposed = true;
            dispose();
        };
    }

    get size() {
        return this.elements.length;
    }

    has(element) {
        return this.elements.includes(element);
    }

    [Symbol.iterator]() {
        return this.elements[Symbol.iterator]();
    }
}

export default class DOMRenderer {
    constructor(juris) {
        this.juris = juris;
        this.elementKeys = new WeakMap(); // element -> key, for keyed reconcile
        this.disposers = new WeakMap(); // element -> [dispose], its own bindings and listeners
        this.slots = new WeakMap(); // seat node -> { disposeBinding }
        this.owned = new WeakSet(); // nodes Juris created (enhance refuses to reach inside them)
        this.componentInstances = new WeakMap(); // root node -> [instance], innermost first
        this.enhanced = new WeakSet(); // foreign elements adopted through enhance()
        this.pendingCounts = new WeakMap(); // element -> number of its bindings waiting on a promise
        this.localSlots = new WeakMap(); // root node -> { componentName: local-state slot path }, for handover on re-invocation
        this.appliedProps = new WeakMap(); // element -> the properties its last layout applied, so a reuse can clear what the new one lacks
        this.owner = null; // the component instance whose layout is being rendered right now (bindings and children record it)
        this.depth = 0; // nesting of DOM operations; onMount handlers run when the outermost one finishes
        this.pendingMounts = []; // instances whose onMount handlers are due
        // > 0 while an enhanced subtree is being built: no layout under it may set innerHTML. Carried
        // by bindState the way `owner` is, so a child rendered by a binding minutes later is still
        // inside the enhancement that created it — the guard used to see only the root layout.
        this.noHtml = 0;
        // > 0 while an enhancement given { allowHtml: true } is being built, carried the same way: that
        // opt-in opens innerHTML inside it, as the instance's allowInnerHTML opens it everywhere.
        this.allowHtml = 0;
    }

    // ---- ownership context, lifecycle ----------------------------------------------------

    withOwner(owner, fn) {
        const previous = this.owner;
        this.owner = owner;
        try {
            return fn();
        } finally {
            this.owner = previous;
        }
    }

    // Every DOM operation runs inside enter(): when the outermost one finishes, due onMount handlers
    // run — synchronously, so a write followed by an assertion still sees everything, mount effects included.
    enter(fn) {
        this.depth += 1;
        try {
            return fn();
        } finally {
            this.leave();
        }
    }

    leave() {
        this.depth -= 1;
        if (this.depth === 0) {
            if (this.pendingMounts.length) this.flushMounts();
            if (this.componentManager.devMode) this.componentManager.flush();
        }
    }

    flushMounts() {
        while (this.pendingMounts.length) {
            const due = this.pendingMounts.splice(0);
            for (const instance of due) {
                if (instance.disposed || !instance.mounts?.length) continue;
                const handlers = instance.mounts;
                instance.mounts = [];
                for (const handler of handlers) {
                    const result = handler(instance.root);
                    if (typeof result === "function") instance.cleanups.push(result);
                }
            }
        }
    }

    // An error boundary that has finished rendering swaps its root for the fallback layout.
    showFallback(instance, layout) {
        this.enter(() => {
            instance.root = this.withOwner(instance, () => this.mountRoot(instance.root, layout, instance.namespace, instance.props?.key, instance));
        });
    }

    // ---- everything shared with the core is reached through `juris` ------------------
    get stateManager() {
        return this.juris.stateManager;
    }

    get componentManager() {
        return this.juris.componentManager;
    }

    get componentStack() {
        return this.juris.componentStack;
    }

    get api() {
        return this.juris.api;
    }

    get devMode() {
        return this.juris.devMode;
    }

    get allowTags() {
        return this.juris.allowTags;
    }

    get allowSchemes() {
        return this.juris.allowSchemes;
    }

    getState(...args) {
        return this.juris.getState(...args);
    }

    // A binding whose owner element carries data-pending while its promise is slow. The binding remembers
    // the component that was rendering when it was created: later runs render under that owner (so new
    // children get the right parent) and its errors go to that owner's boundaries.
    bindState(resolver, applyValue, target = null) {
        let marked = null;
        let isSlow = false;
        const owner = this.owner;
        const noHtml = this.noHtml;
        const allowHtml = this.allowHtml;
        // enter() + withOwner(), inlined: this runs once per binding per change, so it must not allocate.
        const apply = (value) => {
            const previousOwner = this.owner;
            const previousNoHtml = this.noHtml;
            const previousAllowHtml = this.allowHtml;
            this.owner = owner;
            this.noHtml = noHtml;
            this.allowHtml = allowHtml;
            this.depth += 1;
            try {
                return applyValue(value);
            } finally {
                this.owner = previousOwner;
                this.noHtml = previousNoHtml;
                this.allowHtml = previousAllowHtml;
                this.leave();
            }
        };
        return this.juris.bindState(
            resolver,
            apply,
            (slow) => {
                isSlow = slow;
                if (slow) {
                    // The node may not be in the document yet (first render); look it up once the tree is settled.
                    queueMicrotask(() => {
                        if (isSlow && !marked && (marked = (typeof target === "function" ? target() : target) ?? null)) this.markPending(marked, 1);
                    });
                } else if (marked) {
                    this.markPending(marked, -1);
                    marked = null;
                }
            },
            owner,
        );
    }

    getLayoutEntry(...args) {
        return this.juris.getLayoutEntry(...args);
    }

    normalizeContent(...args) {
        return this.juris.normalizeContent(...args);
    }

    isTextLayout(...args) {
        return this.juris.isTextLayout(...args);
    }

    isSeatLayout(...args) {
        return this.juris.isSeatLayout(...args);
    }

    textOf(...args) {
        return this.juris.textOf(...args);
    }

    getKey(...args) {
        return this.juris.getKey(...args);
    }

    withKey(...args) {
        return this.juris.withKey(...args);
    }

    isRef(...args) {
        return this.juris.isRef(...args);
    }

    invokeDefinition(...args) {
        return this.juris.invokeDefinition(...args);
    }

    watchGetterProps(...args) {
        return this.juris.watchGetterProps(...args);
    }
    markPending(element, delta) {
        const count = (this.pendingCounts.get(element) ?? 0) + delta;
        this.pendingCounts.set(element, count);
        element.toggleAttribute("data-pending", count > 0);
    }

    // ---- ownership / cleanup -------------------------------------------------

    // Most elements own exactly one disposer, so it is stored bare; an array only appears for the second.
    addDisposer(element, dispose) {
        const existing = this.disposers.get(element);
        if (existing === undefined) this.disposers.set(element, dispose);
        else if (typeof existing === "function") this.disposers.set(element, [existing, dispose]);
        else existing.push(dispose);
    }

    // Tears down the bindings and listeners owned by this element only (not its descendants).
    disposeElement(element) {
        const owned = this.disposers.get(element);
        if (owned === undefined) return;
        this.disposers.delete(element);
        if (typeof owned === "function") owned();
        else for (const dispose of owned) dispose();
    }

    // Tears down bindings for an element and its whole subtree. Public: call this before
    // removing a Juris-rendered node from the DOM yourself.
    disposeTree(node) {
        this.disposeSlot(node);
        this.disposeInstances(node);
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        this.disposeElement(node);
        for (const child of Array.from(node.childNodes)) this.disposeTree(child);
    }

    // ---- reactive seats ---------------------------------------------------------
    // A function in a child position is a seat: it always occupies exactly one node in the parent
    // (an empty text node when it shows nothing), and only that node changes when its function re-runs.

    disposeSlot(node) {
        const slot = this.slots.get(node);
        if (!slot) return;
        this.slots.delete(node);
        slot.disposeBinding();
    }

    // Reactive functions receive the DOM they apply to: an attribute or children function gets its element; a
    // seat (a function in a child position) or a component's root function gets the node currently rendered
    // there, null before the first render. Existing zero-argument functions are unaffected.
    createSlot(resolver, namespace, existingNode = null) {
        const slot = { disposeBinding: () => { } };
        let node = existingNode;
        // A component seated here may swap its own root (null -> div once its data loads). mountRoot
        // tells the seat through this, so its next render replaces the node that is actually there.
        slot.setNode = (next) => { node = next; };
        slot.disposeBinding = this.bindChain(
            resolver,
            () => node,
            (layout) => {
                node = this.mountSeat(node, layout, namespace, slot);
            },
            () => node?.parentNode,
        );
        // Still waiting on a promise: an empty text node keeps the seat until the value arrives.
        return node ?? (node = this.mountSeat(null, undefined, namespace, slot));
    }

    // Binds a seat's function, or a component's root function, whose value may itself be a function:
    // each function in the chain is bound one level down and draws through the same `draw`, into the
    // one node its holder keeps (`current`), and a new value at any level lets every level below it
    // go. An inner function used to be a seat of its own on the same node, which the outer one never
    // heard of: once the inner one swapped its node, the outer one drew into the detached node for
    // good, and its next value never replaced the inner one, whose binding kept running. The server
    // evaluates the chain in one go (ssr-renderer.js `node`), and this draws what it drew. Returns
    // the dispose, for the whole chain.
    bindChain(resolver, current, draw, target) {
        let below = null;
        const dispose = this.bindState(
            () => resolver(current() ?? null),
            (layout) => {
                below?.();
                below = null;
                if (this.isSeatLayout(layout)) below = this.bindChain(layout, current, draw, target);
                else draw(layout);
            },
            target,
        );
        return () => {
            below?.();
            below = null;
            dispose();
        };
    }

    // Rebinds a seat to a fresh function (e.g. a component re-invoked with new props).
    updateSlot(node, resolver, namespace) {
        this.disposeSlot(node);
        return this.createSlot(resolver, namespace, node);
    }

    mountSeat(current, layout, namespace, slot) {
        if (current) {
            this.slots.delete(current);
            this.disposeInnerInstances(current); // whatever was seated here is gone, even if the node is reused
        }
        const node = this.mountNode(current, layout, namespace);
        this.slots.set(node, slot);
        return node;
    }

    // Represents `layout` at `current`: the element is updated in place when the tag matches,
    // handed to the component when the layout names one, otherwise replaced by a fresh node.
    mountNode(current, layout, namespace) {
        if (this.isTextLayout(layout) && current?.nodeType === Node.TEXT_NODE) {
            const text = this.textOf(layout);
            if (current.nodeValue !== text) current.nodeValue = text;
            return current;
        }
        if (this.canReuseRoot(current, layout)) return this.updateElement(current, layout, namespace);
        if (current?.nodeType === Node.ELEMENT_NODE && !this.isTextLayout(layout) && this.componentManager.has(this.getLayoutEntry(layout).tag)) {
            return this.createComponent(layout, namespace, current);
        }
        const node = this.createElement(layout, namespace);
        if (current) {
            this.disposeTree(current);
            current.replaceWith(node);
        }
        return node;
    }

    // ---- component instances ---------------------------------------------------

    attachInstance(node, instance) {
        let list = this.componentInstances.get(node);
        if (!list) {
            list = [];
            this.componentInstances.set(node, list);
        }
        list.push(instance);
        this.recordLocalSlot(node, instance);
    }

    // The node remembers which local-state slot each component name used on it, so a later same-name
    // instance taking the node over (re-invocation with new props) continues with the same state.
    recordLocalSlot(node, instance) {
        if (instance.local === undefined) return;
        const slots = this.localSlots.get(node) ?? {};
        slots[instance.name] = { slot: instance.local, key: instance.props?.key };
        this.localSlots.set(node, slots);
    }

    findInstance(node, name) {
        const list = this.componentInstances.get(node);
        return list?.find((instance) => instance.name === name);
    }

    disposeInstance(instance) {
        instance.disposed = true;
        this.componentManager.untrack(instance);
        instance.disposeBinding();
        instance.disposeBinding = () => { };
        const cleanups = instance.cleanups;
        instance.cleanups = [];
        for (const cleanup of cleanups) cleanup();
    }

    disposeInstances(node) {
        const list = this.componentInstances.get(node);
        if (!list) return;
        this.componentInstances.delete(node);
        for (const instance of list) this.disposeInstance(instance);
    }

    // Before a node is reused as the root of a different layout, the components that currently
    // render into it must go. Instances are attached innermost-first, so everything listed before
    // `owner` was rendered inside it; `owner` itself and the outer instances after it stay alive.
    // With no owner (a seat or a reconciled child), every instance on the node belongs to that slot.
    // An owner that is not attached yet (a fresh instance taking over an existing root) owns nothing.
    disposeInnerInstances(node, owner = null) {
        const list = this.componentInstances.get(node);
        if (!list) return;
        const ownerIndex = owner ? list.indexOf(owner) : list.length;
        if (ownerIndex === -1) return;
        const inner = list.splice(0, ownerIndex);
        if (list.length === 0) this.componentInstances.delete(node);
        for (const instance of inner) this.disposeInstance(instance);
    }

    // ---- property application -------------------------------------------------

    resolveTarget(target, method) {
        const element = typeof target === "string" ? document.getElementById(target) : target;
        if (!element) throw new Error(`Juris.${method}: target "${target}" not found`);
        return element;
    }

    // A style is CSS, and CSS built from data is an injection of its own kind: `background:
    // url(https://elsewhere/?v=<something the page knows>)` makes the browser fetch it, and an
    // attacker-supplied value reaches the attacker. Values are escaped for the attribute, so this
    // cannot break out of the style — but it can still say things inside it. Nothing here can tell
    // a string a component wrote from one a row carried, so the rule is for the caller: build a
    // style from an object with known keys, not from a string that came from data.
    // A custom property (`--accent`) is no property of element.style: assigning one set nothing, so
    // the client dropped what the server had written. It goes through setProperty. A value of
    // nothing (null, undefined, "") removes any key, as the server leaves such a key out: assigned
    // as it was, `undefined` became the string "undefined", which CSS ignores, so a re-draw kept
    // the value before it.
    // Keys and values are held to the server's rule (html-safety.js checkStyle): a key that is no
    // property (`cssText` would replace the whole style, which the server never wrote) is left
    // alone, and a value that would carry declarations of its own is not written, taking off the
    // value before it, as a refused attribute is removed.
    applyStyle(element, styles, previousStyles) {
        if (typeof styles === "string") {
            element.style.cssText = styles;
            return;
        }
        const set = (key, value) => {
            const check = checkStyle(key, value);
            if (!check.ok) {
                if (this.devMode) console.warn(`Juris: dropped ${check.reason}`);
                if (check.name === undefined) return;
                value = "";
            }
            const none = value === null || value === undefined || value === "";
            if (!key.startsWith("--")) element.style[key] = none ? "" : value;
            else if (none) element.style.removeProperty(key);
            else element.style.setProperty(key, String(value));
        };
        if (previousStyles && typeof previousStyles === "object") {
            for (const styleKey in previousStyles) {
                if (!(styleKey in styles)) set(styleKey, "");
            }
        }
        for (const styleKey in styles) {
            set(styleKey, styles[styleKey]);
        }
    }

    applyAttribute(element, name, value) {
        if (this.rejectLayout(value, name)) return;
        if (value === null || value === undefined) {
            if (checkAttribute(name, null).ok) element.removeAttribute(name);
            return;
        }
        // The same refusal as the server (html-safety.js): a data-driven attribute name, or a URL
        // whose scheme runs code, is dropped — and if a previous value got through, removed.
        const check = checkAttribute(name, value, this.allowSchemes);
        if (!check.ok) {
            if (this.devMode) console.warn(`Juris: dropped ${check.reason}`);
            if (checkAttribute(name, null).ok) element.removeAttribute(name);
            return;
        }
        const namespace = attributeNamespace(element, name);
        if (namespace) element.setAttributeNS(namespace, name, value);
        else element.setAttribute(name, value);
    }

    applyBooleanAttribute(element, attribute, value) {
        if (value) {
            element.setAttribute(attribute, "");
        } else {
            element.removeAttribute(attribute);
        }
        if (attribute in element) {
            element[attribute] = Boolean(value);
        }
    }

    applyValueProperty(element, value) {
        const next = value === null || value === undefined ? "" : String(value);
        // An <option>'s value is an ATTRIBUTE that falls back to the option's own text when absent,
        // and properties are applied before children. So `value: ""` compared equal to the empty
        // option's value, the assignment was skipped as a no-op, the text landed afterwards — and
        // the option's value silently became its label: a placeholder's label was submitted as its value.
        // Options have no caret to protect, so the attribute is written outright.
        if (element.localName === "option") {
            if (element.getAttribute("value") !== next) element.setAttribute("value", next);
            return;
        }
        // Only assign when changed so reactive updates don't reset the caret while the user types.
        if (element.value !== next) element.value = next;
    }

    // Applies a value now, or binds it reactively if it's a function. Bindings are owned by the element.
    bindProperty(element, propertyValue, apply) {
        if (typeof propertyValue === "function") {
            this.addDisposer(
                element,
                this.bindState(() => propertyValue(element), apply, element),
            );
        } else {
            apply(propertyValue);
        }
    }

    // A layout (element or component) only means something in a child position.
    rejectLayout(value, position) {
        if (value === null || typeof value !== "object") return false;
        if (this.devMode) console.warn(`Juris: a layout was returned for "${position}", which only accepts text-like values; ignored`, value);
        return true;
    }

    // ---- enhance: adopt existing (server-rendered or foreign) DOM ---------------------
    //
    // enhance(target, enhancer, options)
    //   target      element | element list | id | CSS selector
    //   enhancer    layout content, a { Component: props } layout, or (api) => either.
    //               A function enhancer runs like a component definition, taking the component api
    //               (destructurable: ({ getState, setValue, onCleanup }) => ...) plus api.element, the
    //               element being enhanced. onCleanup handlers run when the element is unenhanced,
    //               rebound, or removed.
    //   options     within: root for selector + observer (default document)
    //               allowHtml: permit innerHTML (default false: enhanced DOM never takes HTML from state)
    //               force: allow enhancing inside a Juris-rendered subtree
    //               observe: keep enhancing matches added later and dispose ones removed
    //               dryRun: return the matches without binding anything
    // Returns an Enhancement: { elements, size, has(el), disposed, dispose(), [Symbol.iterator] }.
    // With observe, `elements` tracks matches as they come and go. Enhancing an element twice
    // rebinds it; it never stacks.

    enhance(target, enhancer, options = {}) {
        const within = options.within ?? document;
        const selector = typeof target === "string" && !document.getElementById(target) ? target : null;
        const elements = this.resolveEnhanceTargets(target, selector, within);

        if (this.devMode) console.debug(`Juris.enhance: ${elements.length} element(s) matched`, target);
        if (options.dryRun) return new Enhancement(elements, () => { });

        this.enter(() => {
            for (const element of elements) this.enhanceElement(element, enhancer, options);
        });

        let observer = null;
        if (options.observe && typeof MutationObserver === "function") {
            observer = new MutationObserver((records) => {
                for (const record of records) {
                    for (const node of record.removedNodes) {
                        this.disposeEnhancedWithin(node);
                        for (let index = elements.length - 1; index >= 0; index -= 1) {
                            if (!elements[index].isConnected) elements.splice(index, 1);
                        }
                    }
                    if (!selector) continue;
                    for (const node of record.addedNodes) {
                        if (node.nodeType !== Node.ELEMENT_NODE) continue;
                        const matches = node.matches(selector) ? [node, ...node.querySelectorAll(selector)] : Array.from(node.querySelectorAll(selector));
                        for (const match of matches) {
                            if (!this.enhanced.has(match)) {
                                this.enter(() => this.enhanceElement(match, enhancer, options));
                                elements.push(match);
                            }
                        }
                    }
                }
            });
            observer.observe(within, { childList: true, subtree: true });
        }

        return new Enhancement(elements, () => {
            observer?.disconnect();
            for (const element of elements.splice(0)) this.unenhance(element);
        });
    }

    unenhance(element) {
        if (!this.enhanced.has(element)) return;
        this.enhanced.delete(element);
        this.disposeTree(element);
    }

    resolveEnhanceTargets(target, selector, within) {
        if (selector) return Array.from(within.querySelectorAll(selector));
        if (typeof target === "string") return [document.getElementById(target)];
        if (target instanceof Node) return [target];
        if (target && typeof target[Symbol.iterator] === "function") return Array.from(target);
        throw new Error("Juris.enhance: target must be an element, a list of elements, an id, or a selector");
    }

    isInsideOwned(element) {
        for (let node = element; node; node = node.parentNode) {
            if (this.owned.has(node)) return true;
        }
        return false;
    }

    disposeEnhancedWithin(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (this.enhanced.has(node)) this.unenhance(node);
        for (const descendant of node.querySelectorAll("*")) {
            if (this.enhanced.has(descendant)) this.unenhance(descendant);
        }
    }

    enhanceElement(element, enhancer, options) {
        if (!options.force && this.isInsideOwned(element)) {
            throw new Error("Juris.enhance: element is inside a Juris-rendered subtree; its properties belong to that layout (pass { force: true } to override)");
        }

        // Rebind, never stack.
        if (this.enhanced.has(element)) {
            this.disposeElement(element);
            this.disposeInnerInstances(element);
        }
        this.enhanced.add(element);

        // A function enhancer is an anonymous component adopting this element: it gets the api (with the
        // element on it), and its onCleanup handlers live on an instance attached to the element so
        // unenhance/removal runs them.
        let layout = enhancer;
        let instance = null;
        if (typeof enhancer === "function") {
            instance = { name: "enhance", props: { element }, cleanups: [], disposeBinding: () => { }, adopted: true, parent: null, root: element };
            this.componentManager.track(instance);
            this.componentStack.push(instance);
            try {
                layout = enhancer(Object.freeze({ ...this.api, element }));
            } finally {
                this.componentStack.pop();
            }
            if (instance.cleanups.length || instance.mounts?.length || instance.errorHandler) this.attachInstance(element, instance);
            if (instance.mounts?.length) this.pendingMounts.push(instance);
        }

        this.withOwner(instance, () => {
            const tag = layout && typeof layout === "object" ? Object.keys(layout)[0] : undefined;
            if (tag && this.componentManager.has(tag)) {
                this.adoptComponent(element, layout, options);
                return;
            }

            // The element takes the layout's properties as if the layout had drawn it, so it must be
            // one a layout may draw (checkTag): an <iframe> or a <meta> on the page is not handed a
            // layout's attributes unless allowTags names it.
            const tagCheck = checkTag(element.localName, this.allowTags);
            if (!tagCheck.ok) throw new Error(`Juris.enhance: cannot enhance it: ${tagCheck.reason}`);
            const content = this.normalizeContent(layout);
            this.withNoHtml(options.allowHtml, () =>
                this.applyPropertiesAndChildren(element, content, true, () => this.adoptKeys(element)),
            );
        });
    }

    // Runs `fn` with the enhanced-DOM rule in force: innerHTML anywhere in what it renders — the
    // root layout, a child three levels down, or a child a binding produces later — is refused.
    // `{ allowHtml: true }` on the enhance() call turns it off, as it always did, and opens innerHTML
    // inside that enhancement, which the instance otherwise refuses (innerHTMLCheck).
    withNoHtml(allowHtml, fn) {
        const counter = allowHtml ? "allowHtml" : "noHtml";
        this[counter] += 1;
        try {
            return fn();
        } finally {
            this[counter] -= 1;
        }
    }

    // Whether innerHTML may be written here (html-safety.js checkInnerHTML): refused unless the
    // instance allows it (`allowInnerHTML`) or an enhancement given { allowHtml: true } is being
    // built. An enhancement without it throws instead (applyProperties), as it always did.
    innerHTMLCheck() {
        return checkInnerHTML(this.noHtml === 0 && (this.allowHtml > 0 || this.juris?.allowInnerHTML === true));
    }

    // Server rows carrying data-key become keyed children, so a keyed reconcile retains them.
    adoptKeys(element) {
        for (const child of element.children) {
            if (child.dataset?.key !== undefined && !this.elementKeys.has(child)) this.elementKeys.set(child, child.dataset.key);
        }
    }

    // A component takes over an existing element as its root. The root tag must match and can never
    // be swapped: the server's element stays the server's element.
    adoptComponent(element, layout, options) {
        const { tag: name } = this.getLayoutEntry(layout);
        const previewInstance = { name, cleanups: [], disposeBinding: () => { }, adopted: true, parent: this.owner, root: element, props: this.normalizeContent(this.getLayoutEntry(layout).content) };
        this.componentManager.track(previewInstance);
        const result = this.withOwner(previewInstance, () => this.invokeDefinition(previewInstance, previewInstance.props));
        const namespace = this.namespaceOf(element);
        const check = (rootLayout) => {
            if (this.isTextLayout(rootLayout) || this.isSeatLayout(rootLayout)) {
                throw new Error(`Juris.enhance: component "${name}" must return an element layout to adopt <${element.localName}>`);
            }
            const { tag, content } = this.getLayoutEntry(rootLayout);
            if (this.componentManager.has(tag) || tag.toLowerCase() !== element.localName.toLowerCase()) {
                throw new Error(`Juris.enhance: component "${name}" renders <${tag}> but is adopting <${element.localName}>`);
            }
            const tagCheck = checkTag(tag, this.allowTags);
            if (!tagCheck.ok) throw new Error(`Juris.enhance: component "${name}" cannot adopt it: ${tagCheck.reason}`);
            return rootLayout;
        };
        this.adoptKeys(element);
        this.withOwner(previewInstance, () => {
            this.withNoHtml(options.allowHtml, () => {
                if (typeof result === "function") {
                    previewInstance.disposeBinding = this.bindState(() => result(element), (nextLayout) => {
                        this.updateElement(element, check(nextLayout), namespace);
                    });
                } else {
                    this.updateElement(element, check(result), namespace);
                }
            });
        });
        this.attachInstance(element, previewInstance);
        if (previewInstance.mounts?.length) this.pendingMounts.push(previewInstance);
    }

    // Properties, then children — except `value` on a <select>, which can only take a value its options
    // already offer, so it is applied (or bound) once the children are in place. `between` runs after the
    // properties and before the children (enhance uses it to adopt server keys).
    // What goes inside is drawn in the element's own namespace (childNamespaceOf), asked once its
    // properties are on it: an annotation-xml's `encoding` says whether it holds HTML.
    applyPropertiesAndChildren(element, content, reconcile, between = null) {
        const deferValue = element.localName === "select" && "value" in content;
        this.applyProperties(element, content, deferValue ? "value" : undefined);
        between?.();
        const namespace = this.childNamespaceOf(element);
        // A <select>'s options can be rebuilt without its `value` changing (an unkeyed list whose length
        // changed is replaced wholesale), and the browser drops the selection when the selected <option>
        // node goes. The value binding does not re-run — its own dependency did not change — so re-assert
        // the last value it produced after every children pass. If that option really is gone the assign
        // is a no-op, which is the truthful outcome: nothing can select what no longer exists.
        let reassert = null;
        this.renderChildren(element, content.children, namespace, reconcile, deferValue ? () => reassert?.() : null);
        if (deferValue) {
            let applied;
            this.bindProperty(element, content.value, (value) => {
                applied = value;
                this.applyValueProperty(element, value);
            });
            reassert = () => this.applyValueProperty(element, applied);
        }
    }

    applyProperties(element, properties, skip = undefined) {
        this.appliedProps.set(element, properties); // remembered for clearStaleProperties on a later reuse
        // `class`/`className` first: setting the attribute replaces every class, so applied after `classList` it
        // would wipe the toggled ones (e.g. Link's "active" when the caller also passes `class`). The SSR renderer
        // merges both regardless of order; this keeps the first client render identical to the server's HTML.
        const keys = Object.keys(properties);
        const ordered = keys.some((k) => k === "class" || k === "className") ? [...keys.filter((k) => k === "class" || k === "className"), ...keys.filter((k) => k !== "class" && k !== "className")] : keys;
        for (const k of ordered) {
            const propertyValue = properties[k];
            if (k === "key" || k === "children" || k === skip) {
                continue;
            } else if (k === "innerHTML" || k === "textContent") {
                if (k === "innerHTML" && this.noHtml > 0) {
                    throw new Error("Juris.enhance: innerHTML is not allowed inside an enhanced element (use textContent, or pass { allowHtml: true })");
                }
                if (k === "innerHTML") {
                    // Refused is left out whole, as on the server: nothing is bound, nothing written.
                    const check = this.innerHTMLCheck();
                    if (!check.ok) { if (this.devMode) console.warn(`Juris: dropped ${check.reason}`); continue; }
                }
                this.bindProperty(element, propertyValue, (value) => {
                    if (!this.rejectLayout(value, k)) element[k] = value ?? "";
                });
            } else if (k === "classList") {
                // A key is class names (html-safety.js classTokens): classList.toggle throws on a
                // token with whitespace in it, or an empty one, and took the whole mount down.
                for (const className in propertyValue) {
                    const tokens = classTokens(className);
                    if (tokens.length === 0) continue;
                    this.bindProperty(element, propertyValue[className], (value) => {
                        for (const token of tokens) element.classList.toggle(token, Boolean(value));
                    });
                }
            } else if (k === "style") {
                let previous = null;
                this.bindProperty(element, propertyValue, (value) => {
                    this.applyStyle(element, value ?? {}, previous);
                    previous = value;
                });
            } else if (k.startsWith("on") && typeof propertyValue === "function") {
                const eventName = k.substring(2).toLowerCase();
                element.addEventListener(eventName, propertyValue);
                this.addDisposer(element, () => element.removeEventListener(eventName, propertyValue));
            } else if (BOOLEAN_ATTRIBUTES.has(k.toLowerCase())) {
                this.bindProperty(element, propertyValue, (value) => this.applyBooleanAttribute(element, k, value));
            } else if (k === "value" && "value" in element && element.namespaceURI !== NAMESPACES.svg) {
                this.bindProperty(element, propertyValue, (value) => this.applyValueProperty(element, value));
            } else {
                const name = ATTRIBUTE_ALIASES[k] || k;
                this.bindProperty(element, propertyValue, (value) => this.applyAttribute(element, name, value));
            }
        }
    }

    // ---- layout helpers ---------------------------------------------------------

    getLongestIncreasingSubsequence(values) {
        const predecessors = values.slice();
        const tails = [];

        for (let index = 0; index < values.length; index += 1) {
            const value = values[index];
            if (value === 0) continue;

            let start = 0;
            let end = tails.length;
            while (start < end) {
                const middle = (start + end) >> 1;
                if (values[tails[middle]] < value) start = middle + 1;
                else end = middle;
            }

            if (start > 0) predecessors[index] = tails[start - 1];
            tails[start] = index;
        }

        let length = tails.length;
        const sequence = Array(length);
        let index = tails[length - 1];
        while (length > 0) {
            length -= 1;
            sequence[length] = index;
            index = predecessors[index];
        }

        return sequence;
    }

    // ---- rendering ----------------------------------------------------------------

    reconcileChildren(parent, childLayouts, namespace) {
        const layouts = childLayouts === null || childLayouts === undefined ? [] : Array.isArray(childLayouts) ? childLayouts : [childLayouts];
        const keys = layouts.map((layout) => this.getKey(layout));
        const hasUniqueKeys = keys.every((key) => key !== undefined) && new Set(keys).size === keys.length;

        if (!hasUniqueKeys) {
            const existingNodes = Array.from(parent.childNodes);
            const canPatch = existingNodes.length === layouts.length && layouts.every((layout, index) => this.canPatchNode(existingNodes[index], layout));
            if (canPatch) {
                layouts.forEach((layout, index) => {
                    const node = existingNodes[index];
                    if (this.isSeatLayout(layout)) {
                        this.updateSlot(node, layout, namespace);
                    } else if (node.nodeType === Node.TEXT_NODE) {
                        const text = this.textOf(layout);
                        if (node.nodeValue !== text) node.nodeValue = text;
                    } else if (!this.isUnchangedComponent(node, layout)) {
                        this.disposeInnerInstances(node);
                        this.updateElement(node, layout, namespace);
                    }
                });
                return;
            }
            for (const child of existingNodes) this.disposeTree(child);
            while (parent.firstChild) parent.removeChild(parent.firstChild); // (replaceChildren needs Safari 14)
            for (const child of layouts) this.render(parent, child, namespace);
            return;
        }

        // Keyed mode tracks the nodes that carry a key: elements, and the text node a keyed component
        // renders when its root is not an element (null, text; mountRoot keys it). Stray unkeyed
        // nodes left by an earlier unkeyed pass go. Such a component used to go with them, and was
        // drawn anew, its local state lost, on every reconcile.
        for (const node of Array.from(parent.childNodes)) {
            if (node.nodeType !== Node.ELEMENT_NODE && !this.elementKeys.has(node)) {
                this.disposeTree(node);
                node.remove();
            }
        }

        const existingElements = Array.from(parent.childNodes);
        const oldIndexByKey = new Map(existingElements.map((element, index) => [this.elementKeys.get(element), index]));
        // An element is kept for the layout with its key only when that layout draws the same tag, or
        // names a component (which takes the element over). An element is never given another tag, so
        // a key that moved from <i> to <b> used to keep the <i>, where a fresh draw drew a <b>: such a
        // layout is drawn anew, and the old element goes with the ones whose key went.
        // The element must also be one the renderers would draw (reusableElement): server markup
        // holding an <iframe> is never handed a layout's attributes. A keyed node that is not an
        // element is a component's root, and is kept only for a component.
        const fits = (element, layout) => {
            const { tag } = this.getLayoutEntry(layout);
            if (this.componentManager.has(tag)) return true;
            return element.nodeType === Node.ELEMENT_NODE && reusableElement(element.localName, tag, this.allowTags);
        };
        const nextElements = layouts.map((layout) => {
            const index = oldIndexByKey.get(this.getKey(layout)) ?? -1;
            return index !== -1 && fits(existingElements[index], layout) ? index : -1;
        });
        const kept = new Set(nextElements);

        existingElements.forEach((element, index) => {
            if (!kept.has(index)) {
                this.disposeTree(element);
                element.remove();
            }
        });

        const stableIndexes = new Set(this.getLongestIncreasingSubsequence(nextElements.map((index) => index + 1)));
        // Create and update in layout order, so components come to life in the same order the server
        // rendered them (local-state slots are numbered by creation order); then place them walking
        // backwards, where the element settled in the previous iteration is always the correct next sibling.
        const elements = layouts.map((layout, index) => {
            let element = nextElements[index] === -1 ? null : existingElements[nextElements[index]];
            if (!element) return this.createElement(layout, namespace);
            if (!this.isUnchangedComponent(element, layout)) {
                this.disposeInnerInstances(element);
                element = this.updateElement(element, layout, namespace);
            }
            return element;
        });
        let anchor = null;
        for (let index = layouts.length - 1; index >= 0; index -= 1) {
            const element = elements[index];
            if (nextElements[index] === -1 || !stableIndexes.has(index)) parent.insertBefore(element, anchor);
            anchor = element;
        }
    }

    // Re-applies a fresh layout to a retained keyed element: old bindings/listeners are dropped first
    // so closures over stale data are replaced and nothing accumulates.
    // Returns the element that now represents `layout` (a component may swap its root).
    // `namespace` is the one the element was drawn in, for a component that takes it over; what goes
    // inside the element is drawn in the element's own (childNamespaceOf).
    updateElement(element, layout, namespace) {
        const { content: rawContent, tag } = this.getLayoutEntry(layout);
        if (this.componentManager.has(tag)) {
            return this.createComponent(layout, namespace, element);
        }
        const content = this.normalizeContent(rawContent);
        this.disposeElement(element);
        // What it held inside, when the new layout names nothing inside it (F27): the children pass runs
        // only for a layout with children or text, so `{ span: {} }` in the place of a span that held
        // some would keep it. Read before clearStaleProperties, which works from the same record.
        const previous = this.appliedProps.get(element);
        if (previous && INNER.some((k) => k in previous) && !INNER.some((k) => k in content)) {
            for (const child of Array.from(element.childNodes)) {
                this.disposeTree(child);
                element.removeChild(child);
            }
        }
        // The element is being reused for a DIFFERENT layout (a route swap that keeps the same <main>,
        // say). applyProperties only walks the new layout's keys, so anything the old layout set and
        // the new one does not mention would simply stay. Clear those first.
        this.clearStaleProperties(element, content);
        // textContent/innerHTML replace the child nodes wholesale; their bindings must not outlive them.
        if ("textContent" in content || ("innerHTML" in content && this.innerHTMLCheck().ok)) {
            for (const child of Array.from(element.childNodes)) this.disposeTree(child);
        }
        this.applyPropertiesAndChildren(element, content, true);
        return element;
    }

    // Remove what the previous layout applied to `element` and the next one leaves out. Listeners
    // are already gone (disposeElement); children and text are the children pass's business; a
    // form control's value is state, not styling, and is left alone. An element Juris did not
    // render into before (server HTML on first hydration) has no record and nothing is touched.
    clearStaleProperties(element, content) {
        const previous = this.appliedProps.get(element);
        if (!previous) return;
        for (const k in previous) {
            if (k in content || k === "key" || k === "children" || k === "textContent" || k === "innerHTML" || k === "value") continue;
            if (k.startsWith("on") && typeof previous[k] === "function") continue;
            if (k === "style") { element.removeAttribute("style"); continue; }
            if (k === "class" || k === "className") {
                if (!("class" in content) && !("className" in content)) element.removeAttribute("class");
                continue;
            }
            if (k === "classList") {
                const kept = new Set();
                for (const className in content.classList ?? {}) for (const token of classTokens(className)) kept.add(token);
                for (const className in previous.classList) {
                    for (const token of classTokens(className)) if (!kept.has(token)) element.classList.remove(token);
                }
                continue;
            }
            if (BOOLEAN_ATTRIBUTES.has(k.toLowerCase())) { this.applyBooleanAttribute(element, k, false); continue; }
            const name = ATTRIBUTE_ALIASES[k] || k;
            if (checkAttribute(name, null).ok) element.removeAttribute(name);
        }
    }

    // Can `node` be updated in place to represent `layout` (unkeyed, positional reconcile)?
    canPatchNode(node, layout) {
        if (this.isSeatLayout(layout)) return this.slots.has(node);
        if (this.isTextLayout(layout)) return node.nodeType === Node.TEXT_NODE;
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        const { tag } = this.getLayoutEntry(layout);
        if (this.componentManager.has(tag)) return Boolean(this.findInstance(node, tag));
        return reusableElement(node.localName, tag, this.allowTags);
    }

    // ---- components ---------------------------------------------------------------

    // A retained node whose outermost component is the one `layout` names, with shallow-equal props,
    // needs no work: its own bindings keep it current. Fresh functions or objects in props never compare
    // equal, so components taking callbacks simply fall back to being re-invoked.
    isUnchangedComponent(node, layout) {
        if (this.isTextLayout(layout) || this.isSeatLayout(layout)) return false;
        const { tag, content } = this.getLayoutEntry(layout);
        const instances = this.componentInstances.get(node);
        const instance = instances ? instances[instances.length - 1] : undefined; // (Array.prototype.at needs Safari 15.4)
        if (!instance || instance.name !== tag) return false;
        const previous = instance.props;
        const next = this.normalizeContent(content);
        const keys = Object.keys(next);
        const same = (a, b) => Object.is(a, b) || (this.isRef(a) && this.isRef(b) && a.path === b.path && Object.is(a.defaultValue, b.defaultValue));
        return keys.length === Object.keys(previous).length && keys.every((key) => key in previous && same(previous[key], next[key]));
    }

    canReuseRoot(currentRoot, layout) {
        if (!currentRoot || currentRoot.nodeType !== Node.ELEMENT_NODE || this.isTextLayout(layout) || this.isSeatLayout(layout)) return false;
        const { tag } = this.getLayoutEntry(layout);
        if (this.componentManager.has(tag)) return false;
        return reusableElement(currentRoot.localName, tag, this.allowTags);
    }

    // Makes `layout` the root of `instance` (see mountNode). Instances on a node are ordered innermost-first:
    // the ones created while mounting go in front, then `instance`, then the outer instances it was carrying.
    mountRoot(currentRoot, layout, namespace, key, instance) {
        let carried = [];
        let seat = null;
        if (currentRoot) {
            this.disposeInnerInstances(currentRoot, instance);
            carried = this.componentInstances.get(currentRoot) ?? [];
            this.componentInstances.delete(currentRoot); // lifted off before the node is reused or disposed
            // If this root is also a seat's node, lift the seat off too: replacing the node disposed it,
            // so the seat stopped re-running and the component seated in it was never cleaned up.
            seat = this.slots.get(currentRoot) ?? null;
            if (seat) this.slots.delete(currentRoot);
        }
        if (!carried.includes(instance)) carried.unshift(instance);
        const root = this.mountNode(currentRoot, this.withKey(layout, key), namespace);
        // An element root carries the key in its layout (withKey); a root that is not an element
        // (null, text) has no layout to carry it, so it is keyed here, and a keyed list keeps it.
        if (key !== undefined && root.nodeType !== Node.ELEMENT_NODE) this.elementKeys.set(root, key);
        if (seat) { this.slots.set(root, seat); seat.setNode?.(root); }
        this.componentInstances.set(root, [...(this.componentInstances.get(root) ?? []), ...carried]);
        // Every instance sharing this root moves with it — an outer instance (a RouterView whose child swapped
        // its root) must not keep a detached node as its root, or its next render lands off-document.
        for (const carriedInstance of carried) carriedInstance.root = root;
        this.recordLocalSlot(root, instance);
        return root;
    }

    createComponent(layout, namespace, existingRoot = null) {
        const { content, tag: name } = this.getLayoutEntry(layout);
        const props = this.normalizeContent(content);
        const instance = { name, props, cleanups: [], disposeBinding: () => { }, parent: this.owner, mounting: true, namespace };
        // Which $local numbering this instance counts in. A component the server never rendered
        // (ssr: false) opens its own, because the server's counters never saw anything inside it —
        // see Juris.localScopeFor.
        instance.localScope = this.juris.localScopeFor(name, this.owner);
        // Re-invocation into the same root: the outgoing instance (if still attached) goes first, so its
        // computeds and cleanups are gone before the new definition registers its own, and the root's
        // local-state slot for this component name is handed to the new instance instead of deleted.
        if (existingRoot) {
            const previous = this.findInstance(existingRoot, name);
            if (previous) this.disposeInstance(previous);
            const recorded = this.localSlots.get(existingRoot)?.[name];
            if (recorded && recorded.key === props.key) instance.local = recorded.slot; // same component, same key: same state
        }
        this.componentManager.track(instance);

        // instance.root is the single source of truth for the root node: a fallback swap (showFallback)
        // replaces it, and the root binding must continue from the replacement, not from a stale closure.
        instance.root = existingRoot;
        try {
            this.withOwner(instance, () => {
                const result = this.invokeDefinition(instance, this.devMode ? this.watchGetterProps(name, props) : props);
                if (typeof result === "function") {
                    // A root function whose value is a function too is bound one level down (bindChain),
                    // drawing through mountRoot, so the instance keeps its root and its own binding.
                    instance.disposeBinding = this.bindChain(
                        result,
                        () => instance.root,
                        (nextLayout) => {
                            instance.root = this.mountRoot(instance.root, nextLayout, namespace, props.key, instance);
                        },
                        () => instance.root?.parentNode,
                    );
                    if (!instance.root) instance.root = this.mountRoot(null, undefined, namespace, props.key, instance); // first value still loading
                } else {
                    instance.root = this.mountRoot(instance.root, result, namespace, props.key, instance);
                }
            });
        } catch (error) {
            // Own fallback (decided by a boundary further in, or by this instance's handler): mount it here.
            let fallback = error instanceof FallbackSignal && error.boundary === instance ? error.layout : undefined;
            if (fallback === undefined && !(error instanceof FallbackSignal)) {
                const handled = this.juris.resolveError(instance, error, { phase: "setup", component: name });
                if (!handled) throw error;
                if (handled.boundary !== instance && handled.layout) throw new FallbackSignal(handled.boundary, handled.layout, error);
                fallback = handled.layout; // undefined: swallowed, the component renders nothing
            } else if (fallback === undefined) {
                throw error; // a signal for a boundary further out
            }
            instance.disposeBinding();
            instance.disposeBinding = () => { };
            instance.root = this.withOwner(instance, () => this.mountRoot(instance.root, fallback, namespace, props.key, instance));
        }
        instance.mounting = false;
        if (instance.mounts?.length) this.pendingMounts.push(instance);
        return instance.root;
    }

    // Static children are appended (or reconciled against what is there when `reconcile` is set);
    // a function is a reactive list bound to the element.
    renderChildren(element, children, namespace, reconcile = false, afterApply = null) {
        if (typeof children === "function") {
            this.addDisposer(
                element,
                this.bindState(
                    () => children(element),
                    (layouts) => {
                        this.reconcileChildren(element, layouts, namespace);
                        afterApply?.();
                    },
                    () => element,
                ),
            );
        } else if (children !== null && children !== undefined) {
            if (reconcile) this.reconcileChildren(element, children, namespace);
            else for (const child of Array.isArray(children) ? children : [children]) this.render(element, child, namespace);
        }
    }

    namespaceOf(element) {
        return element.namespaceURI === "http://www.w3.org/1999/xhtml" ? null : element.namespaceURI;
    }

    // The namespace of what is drawn inside `node`: an element's own (null for HTML), except at the
    // parser's integration points (namespaceInside, above: a <foreignObject>, an SVG <title> or
    // <desc>, a MathML token element or an HTML annotation-xml holds HTML again); a fragment or a
    // shadow root, which has none, holds HTML. Every path that draws into an element asks the
    // element, never the namespace its parent was drawn in: a re-draw that kept an <svg> under an
    // HTML element once drew the shapes it added as XHTML elements with no box, and the picture
    // went blank.
    childNamespaceOf(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        return namespaceInside(this.namespaceOf(node), node.localName.toLowerCase(), node.getAttribute("encoding"));
    }

    // Builds a node (and its subtree) without inserting it anywhere.
    createElement(layout, namespace = null) {
        if (this.isSeatLayout(layout)) {
            return this.createSlot(layout, namespace);
        }
        if (this.isTextLayout(layout)) {
            const textNode = document.createTextNode(this.textOf(layout));
            this.owned.add(textNode);
            return textNode;
        }

        const { content: rawContent, tag } = this.getLayoutEntry(layout);
        if (this.componentManager.has(tag)) {
            return this.createComponent(layout, namespace);
        }
        // The same refusal as the server (html-safety.js): a tag that came from data carries its own
        // attributes and cannot be escaped. An empty text node stands in its place, so the node count
        // still matches what the server sent and a keyed reconcile is not thrown off.
        const tagCheck = checkTag(tag, this.allowTags);
        // A component's name with nothing registered under it: said or refused as the instance's
        // `unknownComponents` says (Juris.unknownComponent), as on the server, whether or not the tag
        // is drawn, and told which. Inside <svg> or <math> it is an element, never unknown.
        if (/^[A-Z]/.test(tag)) this.juris.unknownComponent(tag, foreignContext(namespace), tagCheck.ok);
        if (!tagCheck.ok) {
            if (this.devMode) console.warn(`Juris: dropped ${tagCheck.reason}`);
            const placeholder = document.createTextNode("");
            this.owned.add(placeholder);
            return placeholder;
        }
        const content = this.normalizeContent(rawContent);
        const lowerTag = tag.toLowerCase();
        const drawnIn = elementNamespace(namespace, lowerTag);

        const el = drawnIn ? document.createElementNS(drawnIn, tag) : document.createElement(tag);
        this.owned.add(el);
        if (content.key !== undefined) this.elementKeys.set(el, content.key);
        this.applyPropertiesAndChildren(el, content, false);
        return el;
    }

    // `namespace`, when not given, is the target's own (childNamespaceOf): what is drawn inside an
    // SVG <g> is SVG. A caller that names one, null for HTML included, gets that one.
    render(target, layout, namespace) {
        return this.enter(() => {
            const targetElement = this.resolveTarget(target, "render");
            const el = this.createElement(layout, namespace === undefined ? this.childNamespaceOf(targetElement) : namespace);
            targetElement.appendChild(el);
            return el;
        });
    }

    // Replaces the target's content (server-rendered HTML, or a previous mount) with `layout`.
    // Everything Juris owned inside is disposed first; foreign nodes are simply dropped.
    mount(target, layout, namespace) {
        return this.enter(() => {
            const targetElement = this.resolveTarget(target, "mount");
            const el = this.createElement(layout, namespace === undefined ? this.childNamespaceOf(targetElement) : namespace);
            for (const child of Array.from(targetElement.childNodes)) this.disposeTree(child);
            while (targetElement.firstChild) targetElement.removeChild(targetElement.firstChild);
            targetElement.appendChild(el);
            return el;
        });
    }
}