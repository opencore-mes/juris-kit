# Juris: the reference

> **This is Juris's full contract**, as published on npm in `@opencore-mes/juris-kit` (the short
> introduction is [README.md](README.md)). Juris is developed in this repository: the framework's modules
> at its root, `server/` for Node, and its tests in `tests/` (`npm test`, Node 24 or later). Its largest
> user is OpenCore MES (https://github.com/opencore-mes/opencore-mes), which takes it from npm. Where this
> contract says `src/`, read the package's root (in a browser the module server still serves it at
> `/src/`); where it says `tests/framework/` or `npm run test:framework`, read `tests/` and `npm test`.

Juris is a framework for server-rendered web apps whose pages stay live. The server renders every
page whole, so it can be read before any script has run; the browser then makes that same page
interactive, and live queries keep what it shows up to date as the data changes. It has no build
step and no runtime dependency: the code a browser runs is the file on disk, and a database driver
is something the app passes in.

This file is its contract: what an app may use, what the framework promises, what holds each
promise, and what is not there yet. A change to Juris is written down here first (see "The
boundary"), and `tests/framework/readme.test.mjs` fails when a module, an export, a reserved state
root or a stored key is missing from it.

**Where it stands (2026-10-02; "Open" and "Not yet" re-checked against the code that day: none of
them is closed).** Juris runs two real-time sites in production, and `app/hello`, the
smallest app on it. They work around, in their own code, the
issues this version fixes (F1–F27), and are being moved to it. Until then the framework as described
here runs on the QA server and in the tests. The framework's suite is
`npm run test:framework`, which runs `tests/framework/*.test.mjs`: in this checkout `boundary`,
`render`, `core`, `live` and `server`. A test file this contract cites that is not among them
belongs to the suite the framework was reviewed with, which this checkout does not carry; where a
behaviour has changed since, the file that holds it now is cited beside it. "Not yet", at the end,
lists what is missing.

## Contents

- [Your first app](#your-first-app): `app/hello`, file by file, and what happens on a request
- [Why it is built this way](#why-it-is-built-this-way): the problems Juris was designed around
- [The boundary](#the-boundary): what may go in `src/`, and the test that holds it
- [The page contract](#the-page-contract): `#app`, `#state`, `#services` and `start()`
- [Reserved state roots](#reserved-state-roots): `$route`, `$ssr`, `$local`, `$async`, `$server`, `$live`
- [The public API](#the-public-api): components, the component api, and every module
- [What the framework stores in a browser](#what-the-framework-stores-in-a-browser): `STORAGE`
- [The browser floor](#the-browser-floor): the oldest browsers it runs in
- [Security defaults and invariants](#security-defaults-and-invariants): each with its code and its test
- [Not yet](#not-yet)

## Your first app

`app/hello` is the template for a new app: five files, and none of them plumbing. Its test,
`tests/hello.test.mjs`, builds the whole app on in-memory services (no database), renders `/` and a
404, and fails if hello grows an HTTP server, a document, a module matcher or a 500 of its own.

| File | What it holds | Runs |
| --- | --- | --- |
| `app/hello/client/app.js` | The app itself: its routes, the words around every title, and `register(juris)`, which registers its components. | Both sides: the server renders with it, the browser boots with it |
| `app/hello/client/boot.js` | The browser entry. The page imports it once the page is idle, and calls its `start()`. | Browser |
| `app/hello/services.js` | What the app does, as services. Never mounted, so no browser is served it. | Node |
| `app/hello/app.mjs` | `createApp`: one `createJurisServer` call, with the services passed in, so a test can pass its own. | Node |
| `app/hello/server.mjs` | The only file that reads the environment and touches the process: it listens, and closes on a signal. | Node |

Run it with `node app/hello/server.mjs` (development, on http://127.0.0.1:3000), or in production
mode with `PROD=1 BUILD=b1 PORT=3001 node app/hello/server.mjs`.

The app, the same on both sides (`client/app.js`, its comments left out):

```js
export const routes = [
    { path: "/", name: "home", component: "Home", preload: () => [["greeting", "world"]], head: { title: "Hello" } },
    { path: "*", name: "missing", component: "NotFound", head: { title: "Not found" } },
];
export const title = { suffix: " · Hello", fallback: "Hello" };
export function register(juris) {
    juris.registerComponent("App", () => ({ main: { children: [{ RouterView: {} }] } }));
    juris.registerComponent("Home", (props, api) => {
        api.live("greeting", "greeting", "world");
        return { h1: { textContent: () => api.getState("greeting")?.text ?? "" } };
    });
    juris.registerComponent("NotFound", () => ({ p: { textContent: "Nothing here." } }));
}
```

Its service (`services.js`), and the server (`app.mjs`):

```js
import { fail } from "../../src/errors.js";
export const services = {
    async greeting(name) {
        if (typeof name !== "string" || !name.trim()) fail("Say who to greet.", { fields: { name: "Required." } });
        return { text: `Hello, ${name.trim().slice(0, 60)}` };
    },
};

import { createJurisServer } from "../../src/server/kernel.js";
import { routes, register, title } from "./client/app.js";
export const createApp = ({ services, dev = false, build = "dev" }) => createJurisServer({
    root: new URL("../..", import.meta.url), dev, build, services, routes, setup: register,
    api: { live: { public: true, queries: ["greeting"], touches: {} } },
    modules: { mounts: [{ url: "/app/hello/client/", dir: "app/hello/client" }], entry: "/app/hello/client/boot.js" },
    page: { title },
});
```

And the browser entry (`client/boot.js`): `export const start = () => hydrate({ routes, register, title });`,
with `hydrate` imported from `/src/client.js`.

**What happens when a browser asks for `/`.**

1. The kernel answers every request in one fixed order: `/version`, `/healthz`, `/api/`, the
   modules, then pages. `/` is a page.
2. The path is already in its one spelling, nobody is signed in, and the route is `home`. Its
   `preload` names one call, `["greeting", "world"]`, and the kernel runs it before rendering,
   with a context that says it is a preload.
3. `Home` renders from that answer: `api.live` finds the call preloaded and writes its answer at
   `greeting` at once, so the render never waits. The title is the route's `head.title`, "Hello"
   (the `suffix` follows only a name a page takes from its own data, `head.titleFrom`).
4. The kernel writes the document: the markup in `#app`, the state it rendered with in `#state`,
   the callable service names in `#services`, and a loader that imports
   `/app/hello/client/boot.js?v=<hash>-<code id>` once the page is idle and calls its `start()`.
   A guest's page could be cached; hello passes no cache.
5. In the browser, `hydrate` reads `#state` and `#services`, builds the instance with a stub for
   `greeting` that posts to `/api/greeting`, installs the router and the live client, registers the
   components, draws the page again into `#app` (the same markup, now live) and binds the title.
6. `api.live` subscribes to the `greeting` query over the page's one event stream (`/api/events`).
   Hello has no mutation, but a service listed in `live.touches` as touching `greeting` would make
   the server run the query again once per change and send each subscribed page only the leaves
   that changed.

A service's refusal is written for the person reading it: `fail("Say who to greet.", { fields })`
reaches the caller with its words and its field messages, and any other error reads "request
failed" while its detail goes to the server's log.

**Growing it.**

- A page is a route record and a component. Its `preload` lists the calls the page makes, argument
  for argument: a server render answers only what was preloaded, and a call is keyed by its name
  and the JSON of its arguments (`liveKey`).
- A change is a service. `live.touches` names the queries each one changes (`[]` for none), so the
  pages watching them re-run; `fail` refuses with words the caller may read.
- A page with code of its own gets `load` and `register` on its route (see "A route's own code").
- A plugin (forms, the clock) is installed on both sides, in the same order: in `setup` on the
  server, and in `hydrate`'s `plugins` in the browser.
- A page cache and a change bus, for several instances, are options of the kernel and the
  dispatcher (`server/kernel.js`, `server/page-cache.js`, `server/bus/pg-outbox.js`).

**What hello does not show: signing in.** A members app writes these itself today: a request
context (the dispatcher's `context(req, res)`) that reads its session cookie with `parseCookies`,
sets and clears that cookie with `serializeCookie` and `appendSetCookie`, a rule that a viewer
passed as an argument is believed only on a call of kind `"preload"` or `"live"` (`callKind`), and
`live.authorize` rules that match such an argument to the session. That is the code that decides
who sees what, and it is not in the framework yet ("Not yet").

## Why it is built this way

Juris was designed from pain points rather than from a list of features: each part below is there
because its absence cost something. Each is written as the problem, what Juris does about it, where
the code and the tests are, and what it costs.

### The code a browser runs is the file on disk

**The problem.** A build step (bundling, tree shaking, transpiling) makes what runs in production
something other than what anyone read or tested. The premise Juris starts from is that this step is
where most production-only bugs come from: code dropped because it looked unused, one module
loaded twice as two copies that each believe they are the only one, a transform that behaves
unlike the development server. Such a bug appears after a deploy and cannot be reproduced from the
source.

**What Juris does.**

- No build step. Browser modules are ES modules, served as they are on disk. Development reads the
  disk on every request; production serves a snapshot of the same files taken at start.
- The only changes on the way out are `minifyJs` and `minifyCss`, which remove comments and
  whitespace and never rename, fold or drop code (`minify: false` turns them off), and import
  stamping, which rewrites import specifiers and nothing else.
- Nothing is shaken out. A module is downloaded whole, so what a test imported is what a browser
  runs.
- Browser code imports Juris by URL (`/src/client.js`), and the URL layout mirrors the disk, so
  Node and a browser resolve the same relative imports.
- Server code cannot reach a browser by accident: only the flat `src/*.js` is served, never
  `src/server/`, and the browser suite is served only what production serves.

**Where.** `src/server/modules.js` (`createModuleServer`), `src/server/minify.js`. Tests:
`tests/framework/modules.test.mjs` ("the served bytes are the file's own, with only the import
specifiers rewritten"), `tests/framework/minify.test.mjs` (the minifier's cases are in
`tests/framework/server.test.mjs` now, beside the import stamping's),
`tests/framework/boundary.test.mjs`, and `tests/framework/run-juris.mjs`, which serves the browser
suite.

**What it costs.**

- More requests. `app/hello`'s page loads 14 modules, each a request of its own: about 38 KB
  gzipped in all (measured 2026-09-26, file by file, with the framework's own minifier), where a
  bundler would usually send a few files. The page can be read before any of them arrives, since the loader
  waits until the page has loaded and the browser is idle.
- No dead code removed. A browser downloads code no page of the app uses, `ssr-renderer.js` among
  it (about 3 KB gzipped), because `juris.js` imports both renderers.
- The source is written in what the oldest supported browsers run ("The browser floor"): nothing
  translates newer syntax, and there is no TypeScript or JSX.

### A rolling deploy mixes two builds

**The problem.** Instances restart one at a time, so for a while some serve the old code and some
the new, and a page cached or left open before the deploy boots after it. A browser that gets its
page from one build and its modules from another runs code nobody tested together, and a module
loaded under two URLs is two modules (a component registered twice throws).

**What Juris does.**

- A boot snapshot. In production the module server reads every module, asset and root file it
  serves when it starts and serves only those, so an instance waiting its turn serves the code it
  started with, including a file the deploy removed. A module it never had is a 404 (`no-store`),
  never the new checkout's file stamped as this build's. Static files (fonts, pictures, a vendored
  library) are not in the snapshot: production reads each the first time it is asked for, so
  mid-roll an instance may serve the new checkout's copy, which a name that carries its version
  makes harmless (`server/modules.js`, "Static files", below).
- A code id in every module URL. `codeId` is a hash of the snapshot, the build and the transform
  the server applies (its stamper and minifier), and every import
  a served module makes is stamped `?v=<code id>`, in every form a browser follows, so each module
  has one URL. A module is sent `immutable` only when its `?v` names this process's own code id;
  under any other it is revalidated.
- A page contract that never changes between builds (`#app`, `#state`, `#services`, `start()`), so
  a page cached before a deploy boots the next build's entry.
- The skew guard. `hydrate`'s `skewGuard` compares the route the server named the page with the one
  this build names it; when they differ it reloads once, remembering that in `sessionStorage`, and
  never twice.
- A full load instead of a broken page. A route whose code will not load (a module the other build
  lacks) loads that address in full instead, at most once per address.
- An update notice is the app's to draw, from what the framework gives it: `/version` answers the
  running build (`no-store`), and a document can carry the build that wrote it (`buildMeta`).
- Names that both builds share never change: `liveKey`'s output, the live layer's codes
  (`LIVE_CODES`) and the words beside them, and the change bus's table, channel and `$pages`
  target. The live client matches a refusal's code first and its words for one release, so either
  build's client recovers from either build's server. One build id reaches every worker a process
  forks (`startProcess`'s `env`).

**Where.** `src/server/modules.js`, `src/server/document.js`, `src/client.js` (`skewGuard`),
`src/router.js` (`fullLoad`), `src/server/kernel.js` (`/version`), `src/live-protocol.js`,
`src/remote-services.js`. Tests: `tests/framework/modules.test.mjs` (the snapshot, the 404, one URL
per module, `immutable` only under its own code id), `tests/framework/server.test.mjs` (the code id
moves with the transform, and a template `import()` is stamped), the browser suite's "Client boot:
hydrate" and "Router" (the skew guard, and the full load), `tests/framework/sse-client.test.mjs`,
`tests/framework/lifecycle.test.mjs`, `tests/framework/document.test.mjs`; and, for the site in this
repository, its two-instance journey (`tests/two-instances.e2e.mjs`).

**What it does not prevent: a split boot.** A page fetches its modules one by one. If the instance
that answered one of them goes away and the balancer sends the next request to an instance on the
other build, one page boots from two builds. These outcomes have been seen in a mixed-build check
or worked out by reading the code:

- a module asks for an export the other build's copy of a module lacks, and the boot fails to link;
- a module the other build never had answers 404;
- in either case the page stays the server's page, readable and not live, until its next full load;
- in one pairing (a router from one build, a route table from the other) the page's main area was
  drawn blank until the next full load;
- an old page whose router loads a new page module does one full load.

The window is narrow: two requests a few milliseconds apart, with an instance going down between
them. Where it matters, a change is shipped over two releases, the old shape kept for one more.

### A page cache that knows what each page read

**The problem.** Keeping rendered pages is what makes a server-rendered site cheap, but a cache
keyed by URL with a timeout can only guess. Too long, and a change is not shown; too short, and it
saves nothing. And one page made for a signed-in reader, or one that read something its URL does
not carry, served to the next visitor, is a leak.

**What Juris does.**

- `renderRequest({ after })`: `after(result)` is called inside the render's synchronous section,
  after `renderToString` and before the next request can begin, with the same `result(name, ...args)`
  the render answers; what it returns is the render's `after`. For what must read what the render
  itself set (module state an app's components write as they draw), which any later `await` could
  see replaced by another request's render.
- A server render can be traced (`renderRequest({ trace: true })`): the services it called, the
  state roots it read (`peek` included), its live queries, the flags a plugin set (the clock's), any
  component it could not find, and each service whose preloaded call failed (`failed`, read or not).
- `decide` keeps a page only when it was rendered for a guest, is not a 404, had no preloaded call
  fail, drew no unknown component, carries no flag, and read no state root its URL does not key. A
  page that read nothing is kept until the cache is cleared; one that read services, until a change
  names one of them. A failed render is that request's failure, not the page, so it also leaves the
  page kept before it as it was, and hands a stale page's replacement back for the next visitor.
  The route's own call, which the kernel reads for the status and the title, counts as read by the
  page whatever its body calls.
- Invalidation comes from the services. A mutation's `touches` names what it changes, and the
  dispatcher hands those same targets to the cache (`live.onInvalidate`), on this instance and, over
  the change bus, on every other. A render that raced a change is refused (`snapshot()` and `put`),
  and so is any page rendered across an `EVERYTHING` invalidation or a `clear()`.
- The pipeline asks the guard before the cache, never serves a viewer the guests' copy (nor asks the
  cache about a viewer's page, whose refused put would drop the guests' copy), redirects
  every path to one spelling first (`canonicalPath`), and renders a page it may keep from its cache
  key (`pageCacheKey`), so no visitor's other query parameters travel in it.

**Where.** `src/server/page-cache.js`, `src/juris.js` (`renderTrace`), `src/server/kernel.js`
(`createPagePipeline`), `src/server/service-dispatcher.js` (`live.onInvalidate`). Tests:
`tests/framework/page-cache.test.mjs`, `tests/framework/ssr-trace.test.mjs`,
`tests/framework/kernel.test.mjs`, `tests/framework/dispatcher.test.mjs` ("onInvalidate hears every
invalidation, local or off the bus…"), `tests/framework/server.test.mjs` (the own call in the trace,
the viewer's page, a put across `EVERYTHING`).

**What it costs.** The cache is right only as far as the app declares: `touches` must name what
each mutation changes (the dispatcher's `strict` makes every service say), and `unkeyedRoots` the
state roots that vary per request. The cache is in each process's memory. A page for a signed-in
reader is never cached, so such pages cost a render each time. The kernel takes a cache only beside
a dispatcher the app built and wired to it ("Not yet").

### Live queries are pure functions of their arguments

**The problem.** A live query is shared. Every browser subscribed to the same name and arguments
is one group, run once and run again once per change, with no request behind the re-run. A query
that read the session would compute one reader's answer and send it to everyone in the group; and
a query that takes its reader as an argument answers for whoever a browser names.

**What Juris does.**

- The key is the call: `liveKey(name, args)` is `name:JSON(args)`, and the server refuses a
  subscribe whose key is not the one it computes.
- A dispatcher with live queries cannot be built without `live.authorize` or `live.public: true`.
  `authorize(name, args, info)` runs on every subscribe, on a direct POST to a declared query, and
  again while the subscription lives: before a patch is delivered, at most once per `recheckMs` for
  each client and query, and at once on `handler.invalidateAccess` (whatever `recheckMs` is), each
  time with the context captured at subscribe. Nothing re-asks on a clock: a subscription whose
  query never changes stays registered, holding that context and counting against its caller's
  ceilings, until its stream closes or `invalidateAccess` reaches it. What it is sent is still
  gated.
- `live.strictQueries: true` makes the declared `live.queries` the only names a browser may
  subscribe to; a name a `touches` list gives is then an invalidation name only.
- Every call says what kind it is. A service reads `callKind(this)`; a live query's re-run has a
  frozen context that names nobody, and anything that does not say is a stranger's `"direct"` call.
  So an app believes a viewer passed as an argument only on `"preload"` (the server chose it) and
  `"live"` (`authorize` matched it to the session).
- Client ids are minted by the server and bound to the caller (`identify`); each caller has
  ceilings; a stream too far behind is dropped.

**Where.** `src/server/service-dispatcher.js`, `src/live-protocol.js`. Tests:
`tests/framework/juris-hardening.test.mjs` ("live queries are refused until somebody has decided who
may have them", "a direct POST to a live query runs the same authorize as a subscribe", "losing
access stops the patches, without waiting for the client to unsubscribe"),
`tests/framework/dispatcher.test.mjs` (`strictQueries`), `tests/framework/context-invariant.test.mjs`,
`tests/framework/live-bus.test.mjs`, `tests/framework/live.test.mjs` (`invalidateAccess` with
`recheckMs: 0`, `strictQueries` with object targets, one stream per client id).

**What it costs.** Purity is the app's to keep: nothing stops a live query from reading `this`, so
an app should test that each live query answers a direct call as it answers its live run.
`strictQueries` is opt-in. A viewer's personal data needs a group of its own, since there is no
per-viewer channel, and taking access away reaches only the instance that acted ("Not yet").

### Safe by default

**The problem.** The unsafe default is the one nobody notices until someone uses it: a sanitiser
that misses one spelling, an error message that names a table, a form any site can post, an
argument that claims to say who is calling.

**What Juris does.**

- Refused, not sanitised. Both renderers refuse a tag that runs code, loads a document or reaches
  the whole page (`script`, `iframe`, `object`, `embed`, `base`, `meta`, `link`, `style` (SVG's
  too), `plaintext`, SVG's `set` and `animate…`), a tag name that came from data, an
  `on…` or malformed attribute name, `srcdoc`, a URL whose scheme is not allowed (`javascript:` and
  `vbscript:` never, `data:` for an image only), control characters stripped first, a `style`
  object's key that is not a property or value that would end its declaration, and `innerHTML`,
  which is markup, unless the instance says `allowInnerHTML: true`. A refused tag or attribute is
  left out whole (and named on the console in `devMode`); nothing is cleaned up into something else.
  An app widens this only by name (`allowTags`, `allowSchemes`, `allowInnerHTML`), for both sides at
  once, and a list naming anything that is not a tag or a scheme, or an `allowInnerHTML` that is not
  a boolean, is refused when the instance is built. `renderDocument` escapes every value in a page's
  head and throws on what escaping cannot make safe.
- By default, only a `ServiceError`'s words reach a caller. The default `exposeError` is
  `error.expose === true`, which `fail` sets; any other error reads "request failed" and goes to
  the log. That holds for a service's answer, a live query's re-run, a failed preload written into a
  page and the async error logs; `/healthz` and the 500 answer fixed words and never an error's.
- JSON-only calls. A service call must be sent as `application/json` (415 otherwise), which a form
  on another site cannot send without a preflight: that is the defence against cross-site requests.
  The no-JavaScript form path (`forms`) takes only the names the app allows, only when the Origin
  (or the Referer) is the host asked, only up to 16 KiB, through the same pipeline as a JSON call,
  and redirects only to a path on the same site.
- Call kinds, above: a handle in a request's arguments names nobody.
- A page rendered for a reader is never cached, and goes out `private, no-cache`.
- Nothing a request carries ends the process: a target no URL can be made of is a 400, a
  malformed cookie is skipped, a malformed service name is a 400, and an app's context that throws
  is a refusal, never a crash.
- A misspelt option is refused, not ignored (`createJurisServer`, `createPagePipeline`, `hydrate`,
  `createRouter`, `serviceDispatcher`, `sseClient`, `createLifecycle`), and so is a misspelt key
  inside an option that takes its own (the dispatcher's `live`, `strict` and `forms`, `health` and a
  job, `trustProxy`, `modules`, `page`, `juris`, hydrate's `title`, `skewGuard` and `serviceWorker`,
  and the live client's `backoff`): a misspelt guard would otherwise leave every page open, and a
  misspelt `live.strictQueries` would leave its switch off without a word. So is a number that is
  not one (a job's `every`, `health.timeoutMs`, `closeTimeoutMs`, the live layer's waits and
  ceilings, `remoteServices`' `timeoutMs`, `startProcess`'s `backoff`): a wait longer than a Node
  timer keeps fired at once, and a string ceiling compared as none.

**Where.** `src/html-safety.js`, `src/server/document.js`, `src/errors.js`,
`src/server/service-dispatcher.js`, `src/live-protocol.js`, `src/server/http.js`,
`src/server/kernel.js`. Tests: `tests/framework/html-safety.test.mjs`,
`tests/framework/juris-hardening.test.mjs`, `tests/framework/document.test.mjs`,
`tests/framework/errors.test.mjs`, `tests/framework/service-errors.test.mjs`,
`tests/framework/dispatcher.test.mjs` ("forms: every refusal, before and after the service"),
`tests/framework/context-invariant.test.mjs`, `tests/framework/http.test.mjs`,
`tests/framework/lifecycle.test.mjs`, `tests/framework/server.test.mjs`,
`tests/framework/render.test.mjs`, `tests/framework/live.test.mjs`.

**What it costs.** A refusal leaves out what a sanitiser would have drawn a cleaned copy of, so
a layout built from data that carries a refused tag draws nothing for it, and a link with a refused
scheme has no `href`. `innerHTML` is left out unless the instance says `allowInnerHTML: true`; with
it, it is written as given, so it is for the app's own markup, never data (a row spread into props,
a row that lands in a child position, or a component that forwards `...rest`, such as `Link` and
`Await`, carries it through). A `style` object's value that would end its declaration is left out.
A service's `fields` travel as the service wrote them. A page's Content-Security-Policy is the app's to
give (`page.headers`, with the hashes of the page's inline scripts).

### One worker per instance, behind a sticky balancer

**The problem.** A live query uses two connections: the event stream a browser keeps open, and the
subscribe calls it posts. Node's cluster hands connections to its workers independently, so a
subscribe lands on a worker that never minted that client's id, and every live query answers 403.
The streams a server knows are in one process's memory.

**What Juris does.** `startProcess` refuses more than one worker beside live queries, before it
forks anything (exit 1, with a message that says why and what to do instead), unless the app says
`allow`; `createJurisServer` refuses to serve inside a cluster worker beside live queries unless it
is given `allowWorkers`. To use more cores, run more instances, each a process on its own port,
behind a balancer that keeps a browser on one instance (a cookie it sets), with a change bus between
them so that a change made on one reaches the pages and live queries of all.

**Where.** `src/server/process.js`, `src/server/kernel.js`, `src/server/bus/pg-outbox.js`. Tests:
`tests/framework/process.test.mjs`, `tests/framework/server.test.mjs` ("a cluster worker is refused
beside live queries unless the app allows it"), `tests/framework/pg-bus.test.mjs`,
`tests/framework/live.test.mjs` (a replaced worker's backoff, the Postgres bus's reconnect).

**What it costs.** An instance uses one core, so more cores mean more instances and a balancer in
front. When a browser's instance restarts, its stream breaks and the live client opens a new one on
another instance. Taking live access away reaches only the instance that acted, until its peers'
next re-check ("Not yet").

## The boundary

`src/` is everything a second app would otherwise have to write, and nothing that names any one
app.

1. **Framework terms first.** A change is written down here first, as what any app needs rather
   than what one page needs. It starts with a failing framework test: for code that runs in a
   browser, the browser suite where there is one (`test:juris`; not in this checkout, where the
   render and core suites stand in, through their stand-in DOM), a node suite for code that runs in
   Node.
2. **No app vocabulary.** No route, service, table, cookie, storage key, environment variable,
   copy, incident story or citation of an app's specification. An app passes those in.
3. **Two halves.** Top-level `src/*.js` is served to browsers exactly as it is on disk, so it
   imports nothing from `node:`, nothing from npm and nothing from `src/server/`. Node-only framework
   code lives in `src/server/`, is never served, and reads no environment variable. Only an app's
   entry reads the environment.
4. **Safe defaults.** Error messages are denied unless written for the person reading them, unsafe
   tags and `innerHTML` are refused, a live query is refused without `authorize`, a personal page is
   never cached, every value written into a document is escaped, and cluster workers are refused
   beside live queries. An app that wants less says so in its own code ("Security defaults and
   invariants" says where each is held).

Behaviour that belongs to one app is built on the extension points (services, `juris.use(plugin)`,
`extendApi`, route records, and the dispatcher's and the kernel's options), never by special-casing
that app inside a framework file. A framework change lands together with its first user in an app.

**Held by a test, with no exceptions.** `tests/framework/boundary.test.mjs` enforces rules 2 and
3: a top-level `src/*.js` imports only its flat siblings and uses no `Buffer`, `process` or
`require(` in its code (comments and string text aside), nothing in `src/` reads `process`, and
nothing in `src/` or in the framework's own tests, comments included, uses the app vocabulary the
test lists. It also refuses an import cycle anywhere in `src/`, which loads only while no module in
it uses an import during its own evaluation: what two modules both need goes in a leaf they each
import, as `FallbackSignal` did into `errors.js`; and it holds the browser floor (below). Its
allow-list is empty. It started with eight breaches: seven comments that told one app's stories or
cited its documents, now written as the rules they guard, and a read of `NODE_ENV` for the
development-mode warning, now gone (the warning keys off `devMode`, which the app passes). A breach
found now is fixed, not listed. A pattern cannot see every story a comment tells, so review still
reads for them. `tests/framework/readme.test.mjs` holds rule 1's half that a test can: this file
names every module and export. The framework's tests are in `tests/framework/`, apart from the
app's (`npm run test:framework` runs them alone). The suite the framework was reviewed with also
served a browser suite only the flat `src/*.js` and `tests/framework/*.js` (`test:juris`), and held
the whole boundary at once (`test:extraction`: `src/` and `tests/framework/` copied to a directory of
their own, every import checked to land inside the copy, every suite run there with a loader that
refuses anything of the app's). Neither script is in this checkout ("Not yet"); here
`tests/framework/boundary.test.mjs` holds the boundary in place. A skipped test is reported and does
not count as a pass.

## The page contract

A page the kernel writes (`renderDocument`) and the browser entry that boots it (`hydrate`) agree on
four names. They do not change from one build to the next, because a page kept in a cache, or left
open in a tab, boots the entry of whichever build serves it next.

| Name | What it is | Written by | Read by |
| --- | --- | --- | --- |
| `#app` | The element holding the server-rendered body. The browser draws `root` (`{ App: {} }`, so the app registers an `App` component) into it again, replacing the server's markup. | `renderDocument`, `rootId` | `hydrate`, `rootId` |
| `#state` | `<script type="application/json" id="state">`: the state the page was rendered with, as JSON with `<` escaped and the private roots left out (`serializeState`). | `renderDocument`, `stateId` | `hydrate`, `stateId` |
| `#services` | `<script type="application/json" id="services">`: the names of the services the browser may call, JSON with `<` escaped. Written after the state; absent when the app turns it off. | `renderDocument`'s `serviceNames`: the dispatcher's `names`, unless `page.serviceNames` gives a list or `false` | `hydrate`, when not given `services` |
| `start()` | The browser entry's export. The document's loader imports the entry once the page has loaded and the browser is idle (`requestIdleCallback`, or a timer where there is none) and calls it. | The app's entry module | The loader `renderDocument` writes |

**Only the server's JSON script is read** (JR-F15). `hydrate` reads the state, and the service
names, from a `<script type="application/json">` with that id and from nothing else. What a page's
content draws comes earlier in the document than the server's scripts, and a lookup by id alone
once took an element a user's content drew with `id="state"` for the page's state: the page booted
on a state of that user's choosing. The renderers never draw a `<script>` from a layout (a refused
tag), so content drawn from layouts cannot be one. Two things an app can do reopen it, and neither
should ever carry data: `allowTags: ["script"]`, and `innerHTML`, which both renderers write as
markup once the instance says `allowInnerHTML: true`.

**Where.** `src/server/document.js`, `src/client.js`. Tests: `tests/framework/document.test.mjs` ("a
whole document, byte for byte…", "the loader imports the entry once the page is idle and calls its
start()"), `tests/framework/render.test.mjs` (the loader asks whether `requestIdleCallback` is a
function, so an element of that id cannot stand in for it), and the browser suite's "Client boot:
hydrate" ("reads its state and service names from the server's JSON scripts, never from an element
the page's content drew with the same id").

## Reserved state roots

The framework keeps its own state in the same tree as the app's, under the roots below. An app reads
them (through the api where there is one), and writes none of them by hand. An app's own roots
should not start with `$`: nothing enforces it, and it keeps a later framework root from colliding
with one of the app's. A root is written into `#state` unless it is private; an app adds private
roots of its own with `privatePaths`.

| Root | Kept by | What is under it | In `#state` | Named by |
| --- | --- | --- | --- | --- |
| `$route` | The router | `path`, `query` and `hash`, raw (writing `path` is navigating), and, derived from them, `name`, `params`, `matched` and `meta`; in a browser also `history`, `{ index, length }`, the tab's trail. | Yes: the browser adopts the route the server rendered | `createRouter({ routePath })` |
| `$ssr` | The core | `calls`: each preloaded call's answer under its key (`liveKey`), or `{ $error }` for one that failed, with the words `exposeError` allows. | Yes, and the browser drops it after its first mount (`releasePreloaded`) | `new Juris({ ssrPath })` |
| `$local` | The core (`useState`) | `$local.<Component>.<n>.<key>`, component-local state, numbered in render order; `$local.$client.…` under a component with `ssr: false`. | Yes, so a component adopts its own value when the page boots: nothing secret goes in it | `new Juris({ localPath })` |
| `$async` | The state manager | `pending`, `slow`, `started`, `settled`, `errors`, and `groups.<name>` with its own `pending` and `errors`; and `live.<path>`, each live path's `status` and `message` where no live client keeps them (a server, or a browser without one: `api.liveState`). | Never (private), and a server's `clearState` empties it | `new Juris({ asyncPath })` |
| `$server` | Nothing in the framework | Reserved for what a server render needs and must never leave the server. | Never (private) | Not renamed |
| `$live` | The live client (`sseClient`) | `connected`; `generation`, one more on every hello from the server; `reconnects`, one more on every hello that brings back a stream that was lost; and `paths.<path>`, each live path's `status` (`"live"`, `"pending"`, `"failed"`, `"offline"`) and, while it is failed, its `message`, the path written as one segment (`pathSegment` in `state-manager.js`: `%`, `.` and `*` escaped), gone once nothing is subscribed there (`api.liveState`). | No: only a browser has a live client | `sseClient({ statePath })` |

Two names that look like roots are not: `$error` is the key of a failed call inside `$ssr.calls`,
and `$pages` is the page cache's every-page invalidation target (`EVERYTHING`, `ALL`), never state.

## The public API

**What an app imports, and from where.** Browser code imports Juris by absolute URL: the module
server mounts the flat `src/` at `/src/` and stamps every import. Node code imports it by relative
path. There are no bare specifiers and no import map: a browser cannot resolve `import "juris"`
without one.

| Where | An app imports | For |
| --- | --- | --- |
| The browser entry | `/src/client.js` | `hydrate`, the whole client boot |
| The app's own shared modules, when they need it | `/src/forms.js`, `/src/clock.js`, `/src/live-data.js`, `/src/router.js`, `/src/errors.js`, `/src/storage.js` | Plugins, helpers, and what a page names |
| The server's entry and configuration | `src/server/process.js` (`startProcess`), `src/server/kernel.js` (`createJurisServer`) | Starting, and the whole server |
| Services | `src/errors.js` | `fail` |
| Beside the kernel, when an app needs them | `src/server/page-cache.js`, `src/server/bus/pg-outbox.js`, `src/server/db.js`, `src/server/dev-reload.js`, `src/server/http.js`, `src/server/service-dispatcher.js` | A page cache, a change bus, a driver adapter, development reload, cookies, a dispatcher of the app's own |

A component module reaches Juris through its `api` and imports nothing from `src/`, so only an app's
entry points (and the one module that wraps a framework helper for its pages, if it has one) name
where Juris lives. That keeps moving the framework cheap.

### Components and layouts

A component is a function `(props, api) => layout`, registered by name on the instance:
`juris.registerComponent("Home", (props, api) => …)`. `registerComponent(name, definition, { ssr:
false })` registers one the server never renders (it writes a placeholder, and the browser draws the
component). A definition may also return a function, `() => layout`, which is drawn again whenever
what it reads changes. A name is registered once per instance: `registerComponent` refuses a second
definition, and `juris.install(key, registrar)` is how a module whose components several pages draw
registers them once.

A layout is a plain object with one key, the tag, whose value is its content:
`{ div: { className: "card", children: [ … ] } }`. A string or a number as the content is its text
(`{ p: "Nothing here." }`), and `null` an empty element. In the content:

- A capitalised tag names a component, and its content is the component's props:
  `{ Home: { id: 7 } }`.
- `children` is a layout, a list of layouts, text, or a function (a seat: drawn again whenever what
  it reads changes). A component returns one layout, never a list. A seat's function, or a
  definition's, may return a function in turn: it is bound in its place, drawing into the same
  node, and goes when the function above it gives something else, so the chain draws what the
  server draws for it (every function evaluated in turn).
- `textContent` is text, always escaped. `innerHTML` is markup: both renderers leave it out (named
  on the console in `devMode`) unless the instance is given `allowInnerHTML: true`, and then write
  it as given, so it is for the app's own markup and never for data. `enhance` keeps its own rule:
  inside an enhancement it throws unless the call says `{ allowHtml: true }`, which opens it there.
- `key` gives an element its identity in a list, so a keyed list moves elements instead of
  redrawing them. An element keeps its tag: an item whose key stays and whose tag changes is drawn
  anew, as a fresh draw would draw it (a component takes the element over). A keyed component whose
  root is not an element (it draws `null`, or text) keeps its place and its state in a keyed list,
  as an element does.
- `class` or `className`, `classList` (`{ name: boolean }`), `style` (an object, or a string),
  `htmlFor`, and `value` are what they are in the DOM; a boolean attribute (`disabled`, `hidden`,
  `checked`, …) is present when its value is truthy. A `classList` key is one or more class names,
  split on whitespace (`{ "btn active": on }`); an empty key is nothing. A `style` object's keys are
  camelCase properties (`marginTop`, `WebkitTransform`, `cssFloat` for `float`) or custom
  properties (`"--accent"`), which both renderers write alike; `cssText` and anything else is left
  out. A value is a string or a number with no `;`, `{`, `}`, `<`, `\`, `/*` or control character
  (newline included); any other value is left out on both sides (named in `devMode`), and on the
  client it takes off the value before it. A key whose value is `null`, `undefined` or `""` is left
  out by the server and taken off by the client, as is a key a re-draw no longer gives.
- An `on…` key with a function is a listener: `onclick: (event) => …`. An `on…` attribute with a
  string value is never written, nor is any other attribute or tag `html-safety.js` refuses.
- Any value may be a function. It is run to give the value, and run again when the state it read
  changes, updating that attribute or that text alone. That is how Juris is reactive: a function
  that reads `api.getState(path)` is subscribed to that path.
- Children of `svg` and `math` are drawn in those namespaces, and HTML again where the browser's
  parser reads HTML inside them (its integration points), so the page the server wrote is the page
  the client draws: inside SVG's `foreignObject`, `title` and `desc`; inside MathML's `mi`, `mo`,
  `mn`, `ms` and `mtext` (but for `mglyph` and `malignmark`, which stay MathML); and inside an
  `annotation-xml` whose `encoding` is `text/html` or `application/xhtml+xml`, in any case. An
  `annotation-xml` of another encoding holds MathML, but for an `svg`.

A prop may be a plain value, a getter (a function whose name does not start with `on`, read with
`api.prop(value)` inside a binding, so the read is tracked), or a ref to a state path
(`api.ref(path)`). The components every instance has are `Await` (`{ Await: { group, fallback,
onError, tag, children } }`: `fallback` while an async group is pending, the children kept running
behind it), and, with the router installed, `RouterView` and `Link`.

### The component api

Every component is given `api`, the same object on the server and in the browser:

- **State.** `getState(path, default, { track })` is a tracked read; `peek(path)` is an untracked
  one. `setValue(path, value)`, `updateState(path, updater)`, `deleteState(path)`,
  `batch(fn)`, `assign(path, value)` (writes leaf by leaf, so readers of unchanged leaves are not
  woken), `compute(path, resolver)`, `clearState(next)`, `toRaw(value)` and
  `bindState(resolver, apply)`.
- **Local state.** `useState(key, initial)` answers `[get, set]` (see "Local state").
- **Services.** `call(name, ...args)` answers a promise, or, for a call that was preloaded, a
  settled value that runs its callbacks at once. `live(path, name, ...args)` calls a live query,
  writes its answer at `path` and keeps it written as the server pushes changes; inside a component
  the subscription ends with the component. `liveState(path)` says, tracked, whether what is at a
  live path is current: `"live"` (the latest answer is on screen, a preloaded one included),
  `"pending"` (subscribed, the first answer not here yet: what is shown is older, or nothing),
  `"failed"` (the subscribe was refused, or the server could not run the query again; or, with no
  live client, the call rejected), `"offline"` (the stream is down), or `null` where nothing is
  live; `liveMessage(path)` is a failed path's words, or `null`. On a server a preloaded live path
  is `"live"`, and so is the browser's first render of it, so the two draw alike.
  `preloaded(name, ...args)` reads a preloaded answer
  without calling or subscribing. `invalidate(name, ...args)` drops the browser's call cache.
  `group(name)` counts a group's pending promises. `services` is the instance's services.
- **Lifecycle**, during a definition only: `onMount(fn)`, `onCleanup(fn)`, and `onError(handler)`,
  which makes the component an error boundary.
- **Drawing.** `render`, `mount`, `renderToString`, `enhance`, `unenhance`, `registerComponent`,
  `disposeTree`.
- **Props.** `ref(path)` and `prop(value, default)`.
- `isServer`, and `markRender(flag)` for a plugin that must tell a page cache a render is volatile.

A plugin adds its own names, and the api takes each name once:

- the router: `router`, `route()`, `navigate(to, { replace })`, `back()`, `forward()`,
  `canBack()`, `canForward()`, `link(to)` and `isActive(to, { exact })`;
- the live client: `liveStatus()`;
- `clock()`: `now()`;
- `forms()`: `form(path, options)`.

### The Juris instance

An app on the kernel and the client boot never constructs one: `createJurisServer` and `hydrate`
each build the page's instance, and an app gives both the same `juris` options (see "What the
server and the browser are given alike"). The instance's options, for a test or a page that builds
its own: `state`, `services`, `isServer` (true where there is no `document`), `requirePreload`,
`exposeError`, `reportError(error, name, args)`, `privatePaths`, `ssrPath`, `localPath`,
`asyncPath`, `pendingDelay` (200 ms before a pending value counts as slow), `callCache`
(`{ dedupe, ttl }`, browser only), `allowTags`, `allowSchemes`, `allowInnerHTML` (a boolean, `false`
unless given; anything else refused with a `TypeError`), `unknownComponents`, `devMode` and
`onChange`. What an app calls on an instance: `use(plugin, options)`, `extendApi(extension)`,
`registerComponent`, `hasComponent`, `install`, `renderRequest`, `mount(target, layout,
{ release })`, `preload(entries)`, `serializeState()`, `callKey(name, args)`, `renderTrace()`, `api`,
and, in `devMode`, `componentTree()`, `findComponents(name)` and `onTreeChange(fn)`.

`privatePaths` and `asyncPath` name roots of the state: a name with a `.` in it (or an empty one, or
a `privatePaths` that is not a list) is refused at construction with a `TypeError`. A nested name
used to match no root, so what it named was serialised into the page as if it had never been given;
nested private paths are refused, not supported.

### Modules a browser downloads

Top-level `src/*.js`, served as they are on disk at `/src/`.

#### `juris.js`

**Exports:** `Juris` (default), `FallbackSignal`, `BUILTIN_COMPONENTS`, `SHARED_OPTIONS`,
`sharedOptions`.

The core: components, state, `call` and `live`, plugins (`use`, `extendApi`), `renderRequest`,
`mount`. `BUILTIN_COMPONENTS` names the components every instance registers (`Await`), and
`FallbackSignal` is re-exported from `errors.js`. Its `callKey` is the live protocol's `liveKey`.

- **Preloaded answers** are read through two accessors, never by their place in the state (`$ssr`,
  where they travel to the browser) or their keys. `renderRequest` answers
  `{ html, json, result, cache }` (and `trace` when asked: `renderTrace()`'s, with `failed`, each
  service whose preloaded call failed), and `result(name, ...args)` is what that call answered in
  this render (`null` included), or `undefined` when it was not preloaded or failed, whatever the
  instance renders next: a server reads the page's status and title from it.
  `api.preloaded(name, ...args)` is the same answer to a component, in a server render and in the
  browser's first render, for one that must show what another on the page will load before that one
  has written it. It is a read, not a call: no service is reached, `requirePreload` has nothing to
  refuse, and nothing is subscribed, so it runs nothing again when the transfer is released after
  the first mount, and answers `undefined` from then on. In a traced render a preloaded call it read
  is in the trace's `calls`. `cache`, the calls as the preload keeps them, is returned for one more
  release. Each answer is kept as the page carries it, a JSON round trip, so a component that writes
  under a preloaded answer during a render writes into the request's copy, never into the object
  the service answered (which a service that caches, master data, hands every request). An answer
  JSON cannot carry (a cycle, a `BigInt`) is recorded as that call's failure. `renderRequest` copies
  the plain objects and arrays of the `state` it is given, for the same reason (other values, a
  `Date` or a class instance under `$server`, are kept as they are).
- **Live status.** `api.liveState(path)` and `api.liveMessage(path)` ("The component api") read
  where the live client keeps a path's status (`$live.paths`) or, without one, where the core keeps
  it (`$async.live`). Without a live client (a server, or a browser booted with `live: false`)
  `live()` is one call whose answer is assigned; only the latest call at a path writes it, so an
  older answer that arrives late (the arguments moved, or on a server it belongs to a request
  already rendered) is dropped rather than assigned over the newer one. A service that answers
  synchronously is taken too.
- **Registering once.** `hasComponent(name)` says whether a component is registered on the
  instance (the built-ins included). `install(key, registrar)` runs `registrar(juris)` the first
  time the instance is given `key`, a non-empty string, and does nothing for that key again,
  answering `true` when it ran and `false` when it had already: `registerComponent` refuses a name
  it already has, so a module whose components several pages draw registers them once, and the
  instance keeps the "once". The key is a name the module gives itself, never the function, because
  the same module loaded under two addresses is two modules with two functions. A registrar may
  install others, and one that reaches its own key while it is still running is not run again; one
  that throws is remembered, and its error is thrown again to every later caller for that key, so a
  half-registered module never looks done.
- **Unknown components.** A capitalised tag names a component, and when none is registered under
  it both renderers ask the core (`unknownComponent`) before drawing it. The `unknownComponents`
  option says what then: `"element"` (the default) draws an element of that name, as a browser does
  with a tag it does not know; `"warn"` also says so on the console, once per name; `"throw"`
  refuses to draw it (an error like any other, which a boundary may catch; tests use it). Whichever
  it is, a traced server render lists the name in its trace's `unknown`, and `page-cache.js` never
  keeps such a page. A capitalised tag both renderers refuse as an element (`Portal`, `Script`:
  `html-safety.js`) is unknown too, and is still not drawn: its warning says nothing is drawn for
  it, unless `allowTags` lets it be drawn. Lower-case tags, and any tag inside `<svg>` or `<math>`
  (namespaces that name their own elements), are elements, never unknown; inside `<foreignObject>`
  and the other places HTML is drawn again (the `svg` and `math` bullet above) the children are
  HTML, and so is the rule.
- **Options both sides share.** `SHARED_OPTIONS` names the options an app gives its instance
  through the kernel and the client boot, which build it themselves (`allowTags`, `allowSchemes`,
  `allowInnerHTML`),
  and `sharedOptions(value, where)` checks such an object for either side and answers what to hand
  the instance ("What the server and the browser are given alike").

#### `errors.js`

**Exports:** `FallbackSignal`, `ServiceError`, `fail`, `defaultExposeError`, `mayExpose`,
`publicMessage`.

The framework's error classes, in a module that imports nothing, so every other module can import
them without importing each other.

- `FallbackSignal` is thrown through a component tree when an error boundary still rendering wants
  its fallback drawn: the core throws it and both renderers catch it, by `instanceof`, so all three
  import this one class.
- `ServiceError(message, { status = 400, fields, field, code })` is a refusal written for the
  person who reads it. It sets `expose`, which the default `exposeError` reads, keeps a singular
  `field` and folds it into `fields` (unless `fields` already says something for it), and has
  `fields` and `code` only when given. `fail(message, options)` throws one. The browser's stubs
  throw one too, so a caller reads the same shape on either side.
- `defaultExposeError(error)` is the rule a caller's reading is judged by when an app gives none,
  `error.expose === true`, and the default of the dispatcher's, the kernel's and the core's
  `exposeError`. `mayExpose(error, exposeError = defaultExposeError)` says whether a rule lets a
  caller read an error's words; a rule that throws or answers anything but `true` says no.
  `publicMessage(error, exposeError, fallback = "request failed")` is those words, or `fallback`.
  The dispatcher (a refusal, a live query's failed re-run) and the core (a failed preload, a
  server's async error logs) both read a failure through these two.

#### `live-protocol.js`

**Exports:** `liveKey`, `canAddress`, `diff`, `LIVE_CODES`, `CALL_KIND`, `CALL_KINDS`, `callKind`,
`internal`.

What both ends of a live query must compute identically, defined once in a module that imports
nothing.

- `liveKey(name, args)` is a call's key, `name:JSON(args)`. It names a preloaded call, a browser's
  subscription and the server's group, and the server refuses a subscribe whose key is not the one
  it computes, so its output never changes: one byte of difference between two builds is a refused
  subscribe from every open tab during a deploy.
- `canAddress(value)` says whether every own key of an object can be one segment of a state path
  (no `.`, no `__proto__`, and not the empty key, whose path would be its parent's: at the top, a
  patch for it replaced or deleted the whole result); an object that fails it is sent by `diff` and
  written by `assign` whole. `diff(previous, next)` is the leaf patch the server sends; a key is
  deleted when `next` has no own key by that name, so a removed field named `constructor` or
  `toString` is deleted like any other.
- `CALL_KIND`, `CALL_KINDS`, `callKind(thisValue)` and `internal(reason)` are what a service is told
  about who is calling ("Who is calling", below).
- `LIVE_CODES` names the codes the live layer's refusals carry beside their words, which a program
  matches where the words may change: `CLIENT_UNKNOWN` (`live.client-unknown`, 403: a client id
  the server never minted, or minted for another owner, so the answer is a new stream) and
  `NOT_A_QUERY` (`live.not-a-query`). They are wire names and never change.

#### `state-manager.js`

**Exports:** `StateManager` (default), `settled`, `settledError`, `isSettled`, `pathSegment`,
`MAX_ERROR_LOG`.

The reactive state tree, path subscriptions and settled async values. `Juris` constructs its
`StateManager`, and an app reaches it through the component api. `settled(value)` and
`settledError(error)` are values shaped like a promise (`then`, `catch`, `finally`) that are already
resolved or rejected and run their callbacks at once, which is what a preloaded `api.call` answers,
so the same component code runs synchronously on the server and in the browser's first render;
`isSettled(value)` tells one apart.

`pathSegment(text)` makes any text one segment of a state path (`%`, `.` and `*` escaped,
`__proto__` escaped whole), distinct texts giving distinct segments; the live status is kept under
it. The async error logs (`errors` under the async root, and each group's) keep the last
`MAX_ERROR_LOG` (50) entries: in a browser they used to grow for the life of the page. The async
counters never go below 0. `clearState(next)` skips an own `__proto__` key in `next` (`JSON.parse`
makes one), so a parsed state cannot set the root's prototype.

#### `component-manager.js`

**Exports:** `ComponentManager` (default).

Component registration and lifecycle, and in `devMode` the inspectable tree of live instances.
`Juris` constructs it; an app registers through `registerComponent`.

#### `dom-renderer.js`

**Exports:** `DOMRenderer` (default).

The browser renderer: bindings, keyed lists, the reuse of server-rendered elements, and `enhance`,
which adopts markup Juris did not draw. `Juris` constructs it. What is drawn inside an element is
drawn in that element's namespace, on every draw and not only the first: SVG inside `<svg>`, MathML
inside `<math>`, HTML again at the parser's integration points (`<foreignObject>`, an SVG `<title>`
or `<desc>`, a MathML token element, an HTML `annotation-xml`: "Components and layouts"), however it
got there (a re-draw that kept the element, a list or a seat bound inside it, `enhance`). `juris.render(target, layout, namespace)` and
`juris.mount(target, layout, { namespace })` (the renderer's own `mount` takes the namespace as its
third argument) draw inside the target in its own namespace unless given one (`null` is HTML).

An element that is already there (server markup, a previous draw, what `enhance` adopts) is taken
for a layout only when its tag is one the layout could draw (`reusableElement`): otherwise it is
replaced (by the empty text node a refused tag draws), and `enhance` throws on an element, or a
component adopting one, whose tag is refused unless `allowTags` names it (so enhancing a `<link>`, a
`<meta>` or an `<iframe>` needs `allowTags` to name it). On an SVG or MathML element, `xlink:…`,
`xml:…` and `xmlns`/`xmlns:…` attributes are set in their namespaces, as the HTML parser sets them.

An element reused for another layout of the same tag keeps only what that layout gives it: a property
it no longer names is cleared, and so is what the element held inside, its children or its text, when
the layout names neither `children`, `textContent` nor `innerHTML` (F27). So a placeholder such as
`cond ? { span: { className: "badge", children: […] } } : { span: {} }` is an empty span when `cond`
turns false, not a span that still shows the old text without its class. An element Juris has not
drawn into before (server markup on its first hydration) has no record of what it held, and is left
as it is.

#### `ssr-renderer.js`

**Exports:** `SSRRenderer` (default), `escapeText`, `escapeAttribute`.

`renderToString` with an optional trace of what the render depended on. `Juris` constructs its
`SSRRenderer`. `escapeText` escapes `&`, `<` and `>`, and `escapeAttribute` escapes both quotes as
well, so its output is safe in a single- or double-quoted attribute; the document writer uses the
same two. An HTML `<style>` (drawn only with `allowTags: ["style"]`) writes its text as given, the
CSS the parser reads raw, and is left out when the text contains `</style`; inside `<svg>` a
`<style>`'s text is ordinary text and is escaped. A `<script>` drawn with `allowTags: ["script"]`
still has its text escaped ("Open").

#### `html-safety.js`

**Exports:** `safeAttributeName`, `allowedTags`, `safeTagName`, `checkTag`, `reusableElement`,
`checkInnerHTML`, `classTokens`, `checkStyle`, `allowedSchemes`, `safeUrl`, `checkAttribute`.

The tag, attribute, markup, class, style and URL-scheme refusals both renderers apply, so the two
never disagree.

- `checkTag(tag, allowed)` and `checkAttribute(name, value, schemes)` are each renderer's decision
  for one element and one attribute, answering `{ ok, reason }`; `safeTagName`,
  `safeAttributeName` and `safeUrl` are their parts.
- The refused tags are those that run code, load a document or reach the whole page: `script`,
  `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`, `portal`, `base`, `meta`, `link`,
  SVG's `set`, `animate`, `animateMotion` and `animateTransform`, `plaintext` (the parser never
  closes it: the rest of the document, state and loader included, becomes its text) and `style`
  (page-wide CSS from data: attribute-value exfiltration through selectors and `url()`, `@import`),
  SVG's included. `allowTags` opens any of them by name (`allowTags: ["style"]`).
- `reusableElement(localName, tag, allowed)` says whether the DOM renderer may take an element that
  is already there as the one `tag` draws: the same tag, and one `checkTag` allows.
- `checkInnerHTML(allowed)` refuses `innerHTML` unless `allowed === true` (the instance's
  `allowInnerHTML`).
- `classTokens(key)` is a `classList` key's class names, split on ASCII whitespace, empty ones
  skipped.
- `checkStyle(key, value)` answers `{ ok, name, reason }` for one style key: `name` is the CSS
  property (`margin-top`, `--accent`, `-webkit-transform`, `float`), given whenever the key is a
  property; `null`, `undefined` and `""` are a removal, never refused. The rule is "Components and
  layouts"' `style`.
- A URL attribute (`href`, `src`, `action`, `formaction`, …) may be relative, a fragment, `http`,
  `https`, `mailto`, `tel`, `sms`, `geo` or `ftp`, or `data:` for an image.
- `Juris`'s `allowTags` and `allowSchemes` add tags and schemes on the instance given them
  (`allowTags: ["iframe"]`, `allowSchemes: ["magnet", "web+app"]`: names, the schemes' without the
  colon, lower-cased once, added to the list and never taking from it). `allowedTags` refuses a list
  naming anything that is not a tag's name (a letter, then letters, digits or `-`), which would open
  nothing while the app believed it had. `allowedSchemes` refuses a list naming anything that is not
  a scheme's name, or `javascript`, `vbscript` or `data` (which keeps its own rule, an image only),
  and `safeUrl` refuses those three on every URL again, however the value spells them, whatever set
  it is given. No option opens `srcdoc`.
- `server/document.js` checks a page's head against the defaults alone.

#### `router.js`

**Exports:** `createRouter` (also the default), `Router`, `titleOf`, `ROUTER_COMPONENTS`,
`parseQuery`, `formatQuery`, `splitUrl`, `joinUrl`.

Routes, `$route`, links, `navigate`, the Back and Forward trail, and a route's own code.
`createRouter(options)` makes a `Router`, installed with `juris.use(router)`.

- **Options:** `routes`, `mode` (`"history"`, or `"hash"`), `base`, `routePath` (`"$route"`),
  `scroll` (`"top"`, or `false`), `fullLoad(url)`, `guard(to, ctx)`, `context(api)` and `history`.
  Anything else is refused, as is a `guard`, `context` or `fullLoad` that is not a function: a
  misspelt `guard` would leave every route open. `routePath` is a root of the state: a name with a
  `.` is refused.
- **A route record:** `path` (`/lots/:id` names a parameter, `*rest` a named rest parameter, a bare
  `*` the catch-all), `name`, `component`, `props`, `children`, `redirect`, `beforeEnter`,
  `preload(location)`, `load` and `register` ("A route's own code"), `meta` and `head`. The deepest
  matching record wins, a catch-all only when nothing else matches, and a tie goes to the record
  registered first, so a literal route (`/items/new`) is registered before its parameterised
  sibling (`/items/:id`).
- **`resolve(url, extra, ctx)`** gives a server everything for a request: the state, the preload
  list (each matched record's `preload({ ...location, params, ...extra })`), the table's `redirect`,
  and the route the address lands on, so a server never reads the address a second time: `name`
  (null when it has none), `params`, the merged `meta`, `head`, `matched`, and `notFound`, true for
  the catch-all or when no record matches.
- **`guard(to, ctx)`** decides who may open a route, one function on both sides: `resolve` asks it
  with the context it is given (who is asking, on a server; nobody's when none is given), and
  `navigate` with the router's `context(api)` (`() => ({})` unless given), before any record's
  `beforeEnter`. It answers nothing (go on) or a location to send the visitor to instead, which
  `resolve` answers as its `redirect`; anything else, `false` or a promise included, is refused with
  a `TypeError`, so it cannot be async. It must read nothing but its two arguments: a server renders
  every request on one instance, whose state is whichever request rendered last. Back and Forward do
  not ask it (the browser has moved already).
- **A page's name.** A route's `head` is `{ title, titleFrom(data), dataPath, description }`, merged
  over its parents' like `meta` (`router.headOf(matched)`, and `resolve`'s `head`); `meta.title` and
  `meta.titleFrom` stand for `head.title` and `head.titleFrom` for one release.
  `titleOf(head, data, { fallback, suffix, max })` is the one function a server and a browser both
  ask: `titleFrom(data)` names the page from its own data, cut to `max` characters (code points, so
  the cut never leaves a lone surrogate; a flag, a skin tone or a joined emoji at the cut may keep
  only its first code points, since cutting by what a reader sees as one character needs
  `Intl.Segmenter`, Firefox 125, above the floor) and followed by `suffix`; without a name, `head.title`;
  without that, `fallback`. A `titleFrom` that throws, or no data, never names it. The data is the
  answer to the route's own call (its first preload): a server has it from the preload, and a
  browser where the page keeps it, the state path `head.dataPath` names.
- **URLs.** `splitUrl(url)` answers `{ path, query, hash }` and `joinUrl` puts them back.
  `parseQuery(search)` builds an object with no prototype, repeated keys as a list;
  `formatQuery(query)` writes one. A path segment that cannot be decoded is kept as it arrived. A
  path starts with exactly one `/`: a backslash is read as `/` (as a browser reads it, and as the
  kernel's `canonicalPath` does), a tab or a newline is dropped (a browser drops them from a URL),
  and leading slashes collapse to one; so no target the router answers (`resolve`'s `redirect`,
  `resolveTarget`, `link().href`, a navigation) can name another host. `/\evil.com`, `\\evil.com`
  and `//evil.com` all answer `/evil.com`; `/%5Cevil.com` stays a path.
- **Booting on a transferred route.** The browser adopts the route the server rendered; where it is
  the address bar's path, the address bar's query and `#fragment` are kept (the server never sees
  the fragment, and a cached page was rendered from its cache key without the query parameters it
  does not read), so the first URL write no longer replaces them away.
- `Link`'s `href` follows the route (it is bound, and reads `$route.path`), and a click goes where
  the href says when it is clicked: a target resolved against the current route (a name whose
  params come from it) used to be resolved once, and `RouterView` keeps a page's instance when only
  its params change.
- In hash mode the route is compared with the address's fragment alone, so navigating to where the
  tab already is pushes no entry.
- `ROUTER_COMPONENTS` names the components installing a router registers (`RouterView`, `Link`).

#### `forms.js`

**Exports:** `forms` (also the default), `createForm`.

Form state, validation and submit. `juris.use(forms())` adds `api.form(path, options)`;
`createForm(juris, path, options)` is the same without the plugin. The options are `fields`
(initial values), `validate` (a rule per field), `submit` (the service's name), `onSuccess` and
`onError`; the form keeps `values`, `touched`, `errors`, `valid`, `dirty`, `submitted`,
`submitting`, `error` and `serverErrors` under its path.

- A field's own `onblur`, `oninput` and `onchange` (in `field(name, extra)`) run after the form's
  handler, never instead of it, so a caller's `onblur` keeps touch tracking on.
- `submit()` ignores a call made while the service has not answered yet (`<path>.submitting`, so for
  every form object on that path): a double click submits once, and the ignored call resolves
  `undefined` at once.
- A refusal's `fields` go to `<path>.serverErrors.<field>`, cleared by each submit as it starts (so
  a success, or a submit the rules stop, leaves none, whichever field was edited) and then set from
  a refusal's `fields`, keeping only string messages under names a path can address (not
  `__proto__`, no dot), and each field's own cleared when it changes (`set`, and so its input).
  `form.error(name)` is the validate rule's message when it has one to show, and the server's
  otherwise. They are kept apart from `errors.<field>`, which is the rule's computed and which
  `valid` is derived from.
- A service that answered is a success: `onSuccess` throwing, or rejecting, goes to the console,
  never to `<path>.error` or `onError` (it used to read as a failed save, and the user saved again).
- `reset()` clears `submitting` too, so a submit that never answers does not leave the form refusing
  every submit; the answer of a submit made before a `reset()` then leaves the form's state alone
  (`onSuccess` or `onError` is still told). The stubs' `timeoutMs` (`remote-services.js`) ends such a
  call on its own.

#### `remote-services.js`

**Exports:** `remoteServices`, `sseClient`, `diff` (from `live-protocol.js`).

The browser half of services and live queries. The server half, `serviceDispatcher`, is
`server/service-dispatcher.js`, which no browser downloads.

- **`remoteServices(names, { base = "/api", fallback, fetch, timeoutMs = 30000 })`** answers one
  stub per name, each posting its arguments as JSON to `${base}/<name>`; a string second argument is
  still the base. A refusal rejects with a `ServiceError` carrying the status and the answer's
  `fields`, `field` and `code`; `fallback({ name, response, json })` gives the words when the answer
  has none, by default the status line (`502 Bad Gateway`). A 2xx answer whose body is not JSON
  rejects with a `ServiceError` of status 502, code `response.not-json` (`fallback`'s words): it used
  to resolve `{ error: "200 OK" }`, so a captive portal's page read as saved. The dispatcher always
  answers JSON. `timeoutMs` is how long a call (its answer and its body) may take, whole
  milliseconds from 0 (no limit) to 2^31 − 1, anything else refused with a `TypeError`; a call that
  takes longer is aborted and rejects with a `ServiceError` of status 408, code `request.timeout`,
  and the words "The request took too long; it may or may not have been applied.".
- **`sseClient(options)`** is the live client, installed with `juris.use`: one event stream per
  instance, subscribes posted to `${base}/_live`, and each patch written where the view asked.
  Options: `base`; `EventSourceImpl`, the class to use (a test's fake); `idleMs = 10000`, how long a
  stream with nothing left to watch is kept, so a navigation reuses it (0: until the current turn of
  the event loop is over); `hiddenMs = null`, how long a tab may stay hidden (`document.visibilityState`, the
  tab in the background, the window minimised) before its stream is given back to the server: its
  subscriptions are kept and its paths are `"offline"`, nothing is sent to it meanwhile, and the
  moment it is shown again a new stream opens, every subscription is announced again and each path is
  `"pending"` until its fresh full answer (a whole number of milliseconds from 0 to 2^31 − 1; `null`,
  the default, keeps the stream however long the tab is hidden, as before). A tab shown again before
  `hiddenMs` keeps its stream; one already hidden when its stream opens (a tab opened in the
  background) counts `hiddenMs` from that opening. A hidden tab's pause is a close on purpose: no reconnect is counted; `statePath = "$live"`, where the connection is written, `.connected` and
  `.generation`, one more on every hello (continuing from what the state holds), so a component that
  watches it hears of every stream the server greets without polling, and `.reconnects`, one more
  on every hello that brings back a stream that was lost (an error: an instance restarted, the
  network dropped, the stream was refused and reopened), never on a first open or on an open after
  the stream was given back on purpose (the idle close, `dispose()`), so a component that wants to
  hear of a restart watches it rather than the generation, which rises whenever a page opens a
  stream again, and `.paths.<path>`, each live path's status (see `liveState` in "The component
  api"); `onHello({ clientId,
  generation })`, told of every hello, and `onReconnect`, of every one after an install's first
  (an open after the idle close among them, which `.reconnects` leaves out);
  `onError(error, name, args)`, told of a subscribe refused for good (not a stale id, which opens a
  new stream, nor a busy server, asked again), with a `ServiceError` carrying the status, words and
  code, and the console told when there is none, and the path's status is `"failed"` with the same
  words, as it is when the server could not run the query again (a patch with `error`), until the
  next answer; `backoff = { minMs: 1000, maxMs: 30000 }`, the wait
  before a refused stream is reopened or a busy server asked again, doubling from `minMs` to `maxMs`
  and back to `minMs` after a hello.
- The transport's `subscribe(key, name, args, path, { seeded })` takes whether the preload's answer
  is already on screen (then the path starts `"live"`); every path it keeps is `"offline"` while the
  stream is down (an error, a reopen, `close()` with paths still subscribed), and `"pending"` again
  from the hello that brings it back until the new full answer.
- A subscribe refused for a stale client id is known by its code, `live.client-unknown`, and a new
  stream is opened; an answer with no code (a server from before the codes) is matched on its
  words, `/client id/i`, for one release, so either build's client recovers from either build's
  server during a rolling deploy, and an answer with another code is never taken for a stale id.
- A hook that throws or rejects goes to the console and stops nothing. Construction refuses a
  `backoff` whose bounds are not whole milliseconds with 1 ≤ `minMs` ≤ `maxMs` ≤ 2^31 − 1, an
  `idleMs` or a `hiddenMs` (other than `null`) that is not a whole number of milliseconds from 0 to 2^31 − 1, an empty `statePath` and
  a hook that is not a function, and a key that is none of the options above, or one in `backoff`
  other than `minMs` and `maxMs` (`hydrate` hands its `live` object here, so the same keys hold
  there).
- The plugin it returns has `dispose()`: every stream closed, every timer cancelled, the
  `visibilitychange` listener removed, every live path's status it kept removed, and the transport
  taken off each instance it was installed on. An instance has one live client at a time: once it is
  disposed, `juris.use` takes another, and `api.liveStatus`, which the instance's first client adds,
  reads the connection wherever the current one writes it; a client installed while another is live,
  or on an api whose `liveStatus` is not a live client's, is refused before anything is installed.

#### `client.js`

**Exports:** `hydrate` (also the default).

`hydrate(options)` is the client boot: what an app's browser entry does, so the entry is its
options and one call (`export const start = () => hydrate({ routes, register })`). It answers a
promise of the live instance, or `null` when the skew guard reloads. It reads the page contract
("The page contract"), and its order is fixed, because each step needs the one before:

1. parse the state;
2. construct the instance, its services `remoteServices(names, { base: apiBase, fallback })`
   (`apiBase` `"/api"`);
3. install the router made from `routes` and `router` (the router's own options: its `guard`, the
   one the server's router asks, and `context(api)`, what `navigate` asks it with; made before the
   page is read, so an option it refuses is refused first), the live client (`sseClient` at the same
   base unless `live` is `false`; an object is its options), then the app's `plugins` in order,
   which the server installs in the same order, since an api name is taken once;
4. `register(juris)`;
5. the skew guard;
6. await every matched route record's `load` (the router's `loadFor`), so no unregistered component
   is drawn;
7. `beforeMount(juris)` (awaited when it returns a promise), for what the server could not know,
   set before the first render reads it;
8. `mount`, which replaces the server's markup and releases the preloaded calls;
9. the title, bound to `document.title` and re-run when what it reads changes (the server's title
   stands when there is none): `title` is `{ fallback, suffix, max, decorate(text, juris) }`, the
   kernel's options, for the page's name as the server gave it (the router's `titleOf` on the
   route's `head`, with the data the page keeps at `head.dataPath`), or a function `title(juris)`
   that answers the whole title;
10. with `prefetch: "idle"` (the default; `false` for none), every other route's code, one record
    at a time, once the browser is idle, a failure ending the prefetch quietly;
11. `serviceWorker` (a script URL, or `{ url, onMessage(data, juris, event) }`) registered once
    idle, its messages handed to `onMessage`;

and last the instance under the global name `expose`, when given. `juris` is the instance's own
options, `{ allowTags, allowSchemes, allowInnerHTML }`, the same object the server's kernel is
given. The idle steps use `requestIdleCallback` only when it is a function (`typeof`), so an element
with `id="requestIdleCallback"` cannot stand in for it where the browser has none. `stateId`,
`rootId` and `root` rename the page's elements and the root layout. A route whose code fails at
step 6 rejects the promise and leaves the server's page as it was, readable, with nothing exposed.

**The skew guard** (`skewGuard: { storageKey, reload }`, off unless given) compares the name the
server's route table gave the page, read from the state before the router is installed, with this
build's name for the page's path. When they differ this is not the server's code (a module from
another build, in a cache or from another instance mid-deploy), and drawing it would replace the
right page with the wrong one; so it keeps the page's path in `sessionStorage` under `storageKey`,
calls `reload` (`location.reload()` unless given) and answers `null` before anything is fetched or
drawn. A boot that finds its own path already marked draws the page instead and tells the console,
so it never reloads a second time, and a boot that goes ahead clears the mark. When storage will not
keep the mark it does not reload at all, since a reload it cannot remember could be the first of
many. The key is the app's, so the app lists it among what it stores. Any other key in it, and a
malformed one, is refused with a `TypeError` before the page is read, as is any option `hydrate`
does not take, a key `title` or `serviceWorker` does not take, and a `live` object the live client
refuses (it is made before the page is read, beside the router).

#### `live-data.js`

**Exports:** `useLiveData`, `useRouteData`, `claimPath`.

The helpers a component keeps a live query's answer on screen with, when its arguments come from
the route. It imports nothing.

- `useLiveData(api, service, argsFrom, path = service)` subscribes with what `argsFrom()` builds and
  writes the answer at `path`.
- `useRouteData(api, service, params = [], path = service, { viewer })` builds the arguments from
  the route's params, named in order and read where the router installed on the instance keeps the
  route (its `routePath`), then, when `viewer` is given, the value at that state path (null when
  there is none) as the last argument. `viewer` is a path, never `true`: the framework does not know
  where an app keeps who is asking, so an app that always keeps it in one place wraps these with
  that path.
- The arguments are read inside the getter each returns, which is what the component reads the
  answer through, so a page `RouterView` keeps re-subscribes when they change and only then; the new
  subscription exists before the old one is stopped, so a change that arrives mid-swap is not lost,
  and the last answer stays on screen until the next arrives. They must be the route's `preload`
  entry's, argument for argument: a server render answers only what was preloaded.
- The getter both helpers answer carries `path`, `state()` and `message()`, tracked reads of
  `api.liveState(path)` and `api.liveMessage(path)`: between a change of arguments and the new
  answer the last route's data stays on screen and `state()` is `"pending"`, and it is `"failed"`
  for good when the new answer is refused, where it used to be shown under the new route with no
  mark at all.
- `claimPath(api, path, service)` is one live path, one service: a path claimed by one service is
  refused to another, with both named (one service may write several paths), and both helpers claim
  the path they write; a component that subscribes with `api.live` itself claims its path by hand.
  A claim is kept on the instance whose api it is given, so another instance in the process starts
  with none, a server's instance keeps its claims across the requests it renders, and anything that
  is not a component's api is refused.
- An option `useRouteData` does not know, a `viewer` that is not a path and `params` that are not a
  list of names are refused, and so is `useRouteData` on an instance with no router.

#### `clock.js`

**Exports:** `clock`.

`clock(now = () => Date.now())` is the plugin that gives every component `api.now()`, so a
component never reads the time itself and a test hands every component a frozen clock
(`juris.use(clock(() => t))`). Every read during a traced server render marks the render with the
flag `"clock"` (`markRender`, a no-op outside one), and the page cache keeps no render that carries a
flag, so a page that says "Today" is never served after midnight from a copy made before it. Any flag
is volatile, so the name is not a contract with the cache. An app installs it on its server's
instance and in its browser boot alike. It imports nothing.

#### `storage.js`

**Exports:** `STORAGE`, `trailKey`.

What the framework stores in a browser, declared: see "What the framework stores in a browser",
below. `trailKey({ routePath, base })` is the key the router takes its trail length from, so what is
declared is what is written. A leaf.

### Modules for Node only

`src/server/`, never served, reading no environment variable, and depending on no npm package:
database drivers are passed in.

#### `server/kernel.js`

**Exports:** `createJurisServer`, `createPagePipeline`, `createLifecycle`.

What a server does between a request arriving and a page going out. `createJurisServer` is what an
app calls; the other two are its parts, and stay importable on their own.

**`createJurisServer(config)`** answers a promise of `{ listen, handle, render, close, codeId,
juris, router }`.

- It builds the server's `Juris` instance with the app's `juris` (`{ allowTags, allowSchemes,
  allowInnerHTML }`, the same object the browser's `hydrate` is given), `isServer`, `requirePreload`
  (a call a render makes must have been preloaded, never run in the middle of it) and `exposeError`
  (`error.expose === true` unless told, deciding for a failed preload in a page as for a service's
  answer). It installs the router made from `routes` and `router` (the router's own options, above
  all `guard`, asked in `resolve` with `{ viewer }`, who the page's `viewer` hook says is asking;
  `context` is taken and unused here), awaits `setup(juris)` to register the app's components and
  plugins, and then loads every route's code (`router.loadAll()`), so no render meets a route whose
  components are not registered yet; a route whose code cannot be loaded is a server that cannot
  start.
- `api` is the dispatcher's options (`serviceDispatcher(services, "/api", …)`, with the kernel's
  `exposeError` and `onError` unless given) or a handler the app built, `(req, res, url) → boolean`,
  whose `names` say what it answers to and whose `close()`, when it has one, the drain calls.
- `handlers` are the app's own routes beside its pages (uploads, say): `[(req, res, url) →
  boolean]`, asked in turn after `/api/`, the first to answer `true` ending the search.
- `modules` is `createModuleServer`'s options (`mounts`, `assets`, `rootFiles`, `static`, `minify`)
  plus `entry`, the browser entry's URL, which must be a file the module server serves (checked at
  construction).
- `page` is `createPagePipeline`'s hooks (`origin`, `viewer`, `extra`, `before`, `personal`,
  `preload`, `state`, `notFound`, `title`, `head`, `cacheParams`, `onRender`) and `serviceNames`:
  the names written into every page as `#services`, the dispatcher's unless given, `false` for none.
  `head` is also given `versioned(path)`, the module server's URL for a file it serves.
- `cache` is a page cache for guests' pages, accepted only beside a handler the app built: what
  evicts a kept page is the services' invalidations, which the app carries to the cache itself (its
  dispatcher's `live.onInvalidate`), and a dispatcher the kernel builds does not feed one.
- `devReload` is development's reload (`server/dev-reload.js`, made by the app, whose entry alone
  can start the process that replaces this one): its stream is answered, its client goes into every
  page, and the drain ends it. It is refused outside development.
- `trustProxy` (`true` or `{ hops }`, off unless told) makes a dispatcher the kernel builds count
  its callers, for its per-caller ceilings, by the address the nearest proxy saw, unless the app
  gives its own `live.clientKey`; it is refused beside a handler the app built, which counts its
  own.
- A cluster worker is refused beside live queries (a handler the app built is taken to serve them)
  unless `allowWorkers` says otherwise, as `startProcess`'s `allow` would.
- `root` (the app's directory, a path or a `file:` URL), `dev`, `build` (a string, or a function
  asked per request), `services`, `routes`, `setup` and `layout` are what they say; `instance`,
  `instanceHeader`, `health` and `jobs` are `createLifecycle`'s; `closeTimeoutMs`, `onShutdown`
  and `onError` are the drain's, below; `cluster` replaces Node's cluster for a test. An option
  that is not one of these is refused,
  not ignored (a misspelt hook would leave a page unguarded without a word), and so is a key inside
  one that takes its own: `modules`, `page` and `trustProxy` (`hops`) here, `api` by the
  dispatcher, `health` and a job by `createLifecycle`, `router` by the router and `juris` by
  `sharedOptions`. A server that cannot be built closes the dispatcher it made, so a bus
  subscription does not outlive it.

Every request is answered in one order, which is not configurable: the lifecycle's (`x-instance`,
the 400, `/version`, `/healthz`), in development `/__reload`, `/api/` (the dispatcher or the app's
handler), the app's `handlers`, the modules, root files and static files, `/favicon.ico` (204
unless a root file answers it) and `/.well-known/` (404), both without rendering a page, then the
page pipeline; anything that throws is the lifecycle's fixed 500.

`listen({ port = 0, host = "127.0.0.1" })` serves (once; the loopback address unless told, since a
server open to the whole network is something an app asks for) and starts the jobs, answering
`{ port, host, url }`. `close()` drains, and answers the same promise however often it is called:
`/healthz` answers 503 to a request that still reaches the instance; the live event streams and
development's reload streams are ended first (each is a request that never ends by itself, and would
hold the rest); the idle connections are closed and the requests in flight let finish for at most
`closeTimeoutMs` (8000 unless told; a whole number of milliseconds from 0, which cuts them at once,
to 2^31 − 1, anything else refused when the server is made), after which what is still open is
cut; then the jobs stop, a run in flight finishing first, and the stale pages' replacements under
way finish (none begins from then on: a replacement renders with no request, so the server's close
did not wait for it, and it could run after `onShutdown` closed the pool); and last the app's
`onShutdown` hooks run in order, each awaited (a
change bus, a database pool), a failing one reported as `onError(error, "shutdown")` without
stopping the next. The entry says when to close (on a signal: only it touches the process) and ends
the process once `close()` has answered.

**`createPagePipeline(options)`** returns `{ render(url, viewer), handle(req, res, url), close() }`.
`close()` begins no more stale pages' replacements (one scheduled and not yet begun hands its key
back to the cache) and resolves once those under way have finished.
`handle(req, res, url)` answers a page request in an order that is fixed, because it is what keeps a
page from reaching someone it was not for:

1. the path's one spelling (`canonicalPath`; any other is a 301 to it, before anything reads the
   path);
2. who is asking (`viewer(req, url)`, null for a guest);
3. the route as the router's `resolve(url, await extra(viewer), { viewer })` names it, whose
   `redirect` (the router's `guard`, or the route table's own) answers 302 before the cache is
   asked, so a copy kept for guests is never served past a guard;
4. the `before` hooks in order (the first to answer `{ location, status }` redirects, 302 unless
   told);
5. the page cache, for guests only (`cache`, keyed by `pageCacheKey` on `cacheParams`; a stale hit
   is sent while one render replaces it), unless the app's `personal(ctx)` says a guest's request
   carries something theirs alone, whose page is rendered as asked, never kept, never served from
   the guests' copy and sent `private`;
6. the render, which the cache keeps when `put` allows: a page the cache may keep is rendered from
   its cache key, not the address as asked, and so is a stale page's replacement (a page rendered
   from the whole address would carry its first visitor's other parameters in its state to everyone
   it is served to; a parameter a page reads that is not in `cacheParams` never reaches a guest's
   page while there is a cache). A viewer's page, like a `personal` one, is never put to the cache
   at all (`onRender` is told `{ cache: false, reason: "personal" }`): a refused put drops what the
   key holds, and every signed-in page view evicted the guests' copy of that page;
7. the answer through `send`: `public` for a guest, `private` for a viewer, `no-store` with `dev`.

`render(url, viewer)` is the render alone: the route's preload (`router.resolve(url, await
extra(viewer), { viewer })`, which asks the guard again, so no render, a stale page's replacement
included, is drawn past it; a location it answers is the render's `{ redirect }`) with the app's
`preload(ctx)` in front, the router's state with `state(ctx)` beside it, one `renderRequest`
(`layout`, `{ App: {} }` unless told), then the status, the title and the document.

- A route `resolve` calls `notFound` (the catch-all, or no route at all) is a 404, and so is a page
  whose own call (the route's first preload) `notFound(own, ctx)` says is about nothing, `own` being
  that call's answer (`renderRequest`'s `result`), `undefined` when it failed. A 404 is never kept,
  and neither is a page any of whose preloaded calls failed: it goes out as a 200, but what it shows
  is that request's failure. The route's own call counts as read by the page whatever its body
  calls: the kernel reads it for the status and the title, and its answer is in the page's state, so
  it is in the trace the cache decides on (its key in `calls`, its service in `services`, and the
  page is never `static`). A page titled from a service nothing in its body called was kept forever,
  or on no service, and a change to that service never evicted it.
- The title is the router's `titleOf` on the route's `head` and that call's result (a browser given
  the same options, `hydrate`'s `title`, names the page the same): `head.titleFrom(own)`, cut to
  `title.max` characters and followed by `title.suffix`; otherwise `head.title`, otherwise
  `title.fallback`; `title.decorate` is applied to whichever it is, and a failed call or a
  `titleFrom` that throws never names a page. It is worked out inside the render
  (`renderRequest`'s `after`), so a `titleFrom` that reads what the page's own render set (a language
  picked per person, held in a module of the app) reads this page's, never another request's that
  began while this one waited on `notFound`. The description is the route's `head.description`
  unless `head(ctx)` gives one.
- `head(ctx)` gives `renderDocument` the rest of the head, and the kernel adds the title, the
  canonical (`origin` and the page's path, encoded, so a raw request path cannot break the
  attribute; none without `origin`), the `entry` (a URL, or a function asked per page) and
  `devReload`.
- `headers({ scriptHashes, url, route, viewer })` gives the page's own response headers (a
  Content-Security-Policy, `X-Frame-Options`), as `{ name: value }`: asked once per rendered page,
  with the hashes of that page's inline scripts (`inlineScriptHashes`), kept with the page in the
  cache and sent with it, a 304 included. It may not name what `send` writes itself (`content-type`,
  `etag`, `cache-control`, `vary`, `content-encoding`).
- Every hook may return a promise (`extra` included), and every one runs before `renderRequest` or
  after it returns, never between its `clearState` and its `serializeState`, which is what keeps two
  requests on the one instance apart. `ctx` is `{ req, url, route, viewer }` for `before` and
  `personal`, and `{ url, route, viewer }` for the render's hooks (a stale page is replaced with no
  request), with `route` the route the address lands on as `resolve` names it, `{ name, params,
  meta, head, matched, notFound }`, which the pipeline takes as it is and never matches the path
  again.
- The guard is the router's: a pipeline refuses a `guard` of its own, which it would never ask, and
  any option it does not know. `onRender({ key, decision, trace })` follows each render `handle`
  asked the cache about, and `onError(error, where)` gets a failure nobody is waiting for.

**`createLifecycle(options)`** returns `{ serve(handler), start(), drain(), stop(), draining,
skipped }`:
what a server answers before any of the app's code, the 500, and the work it does on a timer.

- `serve(handler)` is the request listener, and for every request, in this order: `x-instance`
  naming the `instance` when `instanceHeader` says so (off unless told, since it publishes a name);
  the request target read as a URL, and a 400 "Bad request." for one no URL can be made of (`//[x`,
  which Node's parser takes and `new URL` refuses; a throw there once ended the whole process);
  `/version`, `{ build }`, `no-store` (`build` a string or a function asked per request, since
  development moves it); `/healthz`, which answers 503 `{ ok: false, error: "stopping" }` with
  `connection: close` once `drain()` has been called, and otherwise runs `health.check()` within
  `health.timeoutMs` (2000 unless told; a whole number of milliseconds, 1 to 2^31 − 1, refused
  otherwise when the lifecycle is made, since the bound is what keeps a database that never answers
  from holding the balancer's question open) and answers 200 `{ ok: true, instance, build,
  ...health.details() }`, or 503 `{ ok: false, error: "unavailable" }` with the reason sent to
  `onError(error, "healthz")`, never to the body, which is public; then the app's
  `handler(req, res, url)`. Anything that throws is `onError(error, "request")` and a 500 whose body
  is a fixed sentence (a response already under way is ended as it is): an error's own words carry
  file paths and driver text.
- `jobs` are `[{ name, every, run, atStart }]`, checked when the lifecycle is made (a name each, no
  two alike, an interval, `every`, a whole number of milliseconds from 1 to 2^31 − 1, about 24.8
  days, the longest a Node timer keeps: a longer one fired every millisecond, so a job wanted
  monthly runs daily and checks whether its day has come; something to run). `start()` runs each on
  its interval, and an `atStart` one at once too; a run that throws or rejects reaches
  `onError(error, "job <name>")` and keeps its schedule; a job never runs beside itself: a tick that
  comes while its previous run is still in flight is skipped, not reported as an error, and
  `skipped` (`{ [job name]: count }`) counts them; a job's timer never keeps the process alive by
  itself. `stop()` clears the timers and resolves once the runs in flight have finished, so what
  they use can be closed after it; a lifecycle once stopped does not start again. A job calls the
  app's own modules, or a service with `internal(reason)` as its context, never a service without
  one.
- `drain()` is the first step of taking an instance out of rotation, and `draining` says whether it
  was taken. `onError` is the log unless given.
- The options are `build`, `instance`, `instanceHeader`, `health` (`check`, `details`,
  `timeoutMs`), `jobs` (each `name`, `every`, `run`, `atStart`) and `onError`: any other key, at the
  top, in `health` or in a job, is refused with a `TypeError` when the lifecycle is made.

#### `server/process.js`

**Exports:** `startProcess`.

`startProcess({ workers, liveQueries, allow, env, workerIdEnv, refusal, exit, onWorkerExit, log,
backoff, cluster, timers })` answers `"serve"` (this process serves: one worker, or a worker already
forked) or `"primary"` (it forked the workers and serves nothing). An app's entry calls it first,
before it opens a pool, runs a migration or starts a job.

- More than one worker on a port is refused beside live queries (`liveQueries`, true unless told),
  because a live query's event stream and the subscribe calls that feed it are separate connections,
  which Node's cluster hands to different workers, and the worker a subscribe lands on never minted
  that client: every live query answers 403. The refusal is decided before anything is forked (a
  primary that forked first would replace each refusing worker forever), says why and what to do
  instead (several instances behind a sticky balancer) unless `refusal` gives the app's own words,
  and calls `exit(1)`; without an `exit`, it is thrown, which stops an entry at its top level just
  the same. `allow` runs workers anyway, for an app that knows otherwise.
- In the primary, every worker is forked with the same `env` (an app passes its build id, so every
  worker stamps the same module URLs and answers the same build) and its own id, "1" to n, in the
  variable `workerIdEnv` names; a worker that exits unasked (not cleanly, not on SIGTERM or SIGINT)
  is replaced with the same `env` and the id "r", after `onWorkerExit(worker, code, signal)`, and
  after a wait: `backoff: { minMs = 1000, maxMs = 30000, resetAfterMs = 30000 }`, the wait doubling
  from `minMs` to `maxMs` while workers keep dying, and starting over once a worker that ran at least
  `resetAfterMs` dies. A worker that cannot start (the database is down) used to be replaced at
  once, for ever: a fork loop. A `backoff` value that is not a whole number of milliseconds is
  refused (`TypeError`).
- The framework reads no environment and ends no process: the entry passes the values it read and
  its own `exit`. `log`, `cluster` and `timers` (`{ setTimeout, now }`) are injectable for a test.

#### `server/service-dispatcher.js`

**Exports:** `serviceDispatcher`, `ALL`.

`serviceDispatcher(services, base, options)` answers a server's service calls over HTTP and serves
its live queries: the event stream, subscribes, and the re-runs an invalidation causes. It imports
`liveKey` and `diff` from `live-protocol.js`: server code may import a browser module, never the
reverse. The handler it returns carries `names`, the service names it answers to (`options.expose`,
or every own function of `services`), fixed when it is made: what a page tells a browser it may
call.

- **Calls.** Every POST must be sent as `application/json` (415 otherwise): a form on another site
  cannot send that type without a preflight, so a service that trusts a cookie cannot be called
  from another site. `options.maxBody` caps a body (1 MB unless told; 413). `options.context(req,
  res)` builds the context a service is called with as `this` (see "Who is calling"). A refusal
  answers `{ error, fields?, field?, code? }`: the message only if `exposeError` allows it ("request
  failed" otherwise), a service's `fields` as given, a singular `field` as it is and folded into
  `fields` with that same message, and `code` only beside a message the caller may read. A
  refusal's status is the `status` its error carries when that is an HTTP error status Node knows
  (a 4xx or 5xx in `http.STATUS_CODES`), 400 when it carries none, and 500 for anything else (a 999,
  a 302, a string): a thrown status used to go out as given. A service that succeeded runs its
  `touches` whatever becomes of its answer: a result JSON cannot carry (a `BigInt`, a cycle) is
  answered as a refusal (400), and the change it made is still invalidated.
  `onError(error, name, args)` hears what was hidden, and a live query's failed re-run.
- **Reserved names.** Two names are the live layer's own endpoints, `events` (the stream) and
  `_live` (the subscribe call), and construction throws if a service it would answer to has one,
  whether or not live queries are on.
- **`strict: { names, flushAll, warn }`** is how an app has every service say what it changes:
  construction throws, listing every problem, when `names` (the list its browsers are given) and
  the services differ either way, when a name in `live.queries`, `live.touches` or `flushAll` is not
  a service, or when a service is none of a declared live query, a `live.touches` entry (`[]` for
  "changes nothing a page shows") or a member of `flushAll`. `warn(message, names)` is told, once,
  the declared queries no `touches` list names.
- **`live`** holds the live queries: `queries`, `touches`, `authorize(name, args, info)` (or
  `public: true`), `identify`, `clientKey(req, owner)`, `bus`, `onInvalidate`, `strictQueries`,
  `retryMs`, `recheckMs` (30000), `graceMs` (30000), `keepAlive`, and the ceilings
  `maxKeysPerClient` (64), `maxGroups` (10000), `maxStreamsPerCaller` (12), `maxGroupsPerCaller`
  (256), `maxPostsPerMinute` (240) and `maxBufferBytes` (1 MB: a stream further behind is dropped).
  Every number among them is checked at construction as `retryMs` is, and a `TypeError` names the
  one that is not: `keepAlive` a whole number of milliseconds from 1 (0 wrote a keep-alive every
  millisecond), `graceMs` and `recheckMs` whole numbers from 0 (the timers, `keepAlive` and
  `graceMs`, at most 2^31 − 1), `maxKeysPerClient`, `maxGroups` and `maxBufferBytes` whole numbers
  from 1 or `Infinity`, and `maxStreamsPerCaller`, `maxGroupsPerCaller` and `maxPostsPerMinute`
  whole numbers from 0 (0 is no ceiling, as it always was) or `Infinity`. A string
  (`maxGroups: "5"`) used to compare as no ceiling. `null` still means the default.
- **The bus.** A mutation's invalidation publishes to `live.bus` beside its local re-runs, not
  before them: a slow or hung pool does not delay this instance's own updates (a failed publish goes
  to `onError`, `live.bus.publish`, and `handler.invalidate` resolves once both are done). What
  arrives off the bus is applied without the bus waiting for the re-runs (a failure goes to
  `onError`, `live.bus.apply`), so one slow query does not stall every change behind it; a bus's
  `read()` or `poll()` therefore resolves once the re-runs are started, not finished.
- **A live query whose result JSON cannot carry** fails like any other failed re-run:
  `onError(error, name, args)`, the subscribers told `{ key, error }`, and nothing kept to answer the
  next subscriber from. It used to be an unhandled rejection.
- **One stream per client id.** A stream reopened with its `?client=<id>` replaces the one that id
  had, which is ended (it used to stay open, uncounted by `maxStreamsPerCaller`, with no
  keep-alive). A stream request that goes away while `identify` runs makes no client and is
  answered nothing (its client used to stay "connected" for good and hold a place under the
  ceiling). A subscribe whose client is dropped (its grace period ended) while `authorize` runs is
  answered 403 `live.client-unknown`, and joins no group.
- **A misspelt option is refused.** The options are `live`, `maxBody`, `context`, `expose`,
  `strict`, `forms`, `exposeError` and `onError`, and `live`, `strict` and `forms` take only the
  keys this section names: any other key, at the top or inside one of the three, and one of the
  three that is not an object, is refused with a `TypeError` at construction. `live: {
  strictQuerys: true }` used to build a dispatcher without the switch it names.
- **`live.strictQueries: true`** makes the names in `live.queries` the only ones a subscribe may
  name. By default every query an array-valued `touches` entry names is subscribable too (the name
  of each target: `"q"`, `{ name: "q", args }` and `{ name: "q", where }` all make `q` subscribable;
  `ALL` makes nothing so) whenever `authorize` lets it be, so a read became subscribable the day a
  mutation said it changes it; with it such a name is an invalidation name only, and a subscribe to
  anything that is no query is refused with 403 and `code: "live.not-a-query"` before `authorize` is
  asked (with or without it, a direct call asks `authorize` about a declared query alone). It is
  opt-in so that an app which subscribes to such a name keeps working until it declares it; an app
  whose `touches` lists name a read that is no query should turn it on. Construction refuses a value
  that is not a boolean.
- **`live.retryMs`** is the `retry:` field every event stream sends first, how long a browser that
  lost the stream waits before it opens it again: 2000 unless said, and construction refuses
  anything but a whole number of milliseconds from 1 that a timer can wait.
- **`live.onInvalidate(targets, { remote })`** is told of every invalidation the instance applies,
  with or without a bus (a mutation's `touches`, a `flushAll` service's `ALL`, `handler.invalidate`,
  and what arrives off the bus, `remote: true`), before anything is awaited, so an app feeds its
  page cache there (`onInvalidate: (targets) => cache.invalidate(targets)`); a throw or a rejection
  goes to `onError` and stops nothing.
- **`handler.invoke(name, args, ctx)`** is one call through the whole pipeline for any transport
  that is not a JSON POST: `authorize` for a declared query, the service with `ctx` as `this` (taken
  as given; one that says no kind is a direct call), its `touches` once it succeeds, and the error
  filter, answering `{ ok: true, result }` or `{ ok: false, status, error, fields?, field?, code? }`,
  what a JSON caller reads. A JSON POST runs the same steps and still answers before its touches
  run. `handler.invalidate(targets)` is for changes that do not come through a service, and
  `handler.invalidateAccess(who)` re-asks `authorize` about a caller's subscriptions at once,
  whatever `recheckMs` is: `recheckMs` paces only the re-check before a patch, and 0 turns that one
  off. (With `recheckMs: 0`, `invalidateAccess` used to ask nothing, and a revocation silently did
  nothing.)
- **`forms: { allow, maxBody = 16384, redirect }`** is the no-JavaScript path, built on `invoke`: a
  form-encoded POST to a name in `allow` (any other is JSON-only, 415) is taken only when its Origin,
  or its Referer when a browser sends no Origin, names the host it was sent to (403 otherwise,
  nothing run), with a body of at most `maxBody` bytes (413); an upload that ends before its body
  does (a tab closed mid-send) runs nothing and is answered 400 if anyone is left to answer (it used
  to reject out of the dispatcher, into the host's 500); the fields as one object the service's
  one argument, the request's context its `this`. The answer is a 303 to `redirect(name, { ok,
  status, message, fields?, result?, req })`, where `message` is the refusal's words when
  `exposeError` lets a caller read them and `null` otherwise, and a location that is not a path on
  this site fails the request instead of sending a browser elsewhere. What is on this site is
  decided by the URL parser the browser will use, which drops tabs and newlines and reads `\` as
  `/`: a location must start with a single `/` and stay on the site it is resolved against. A
  touches entry that fails is reported to `onError` (`live.touches`), never to the caller.
- **`ALL`** is every page: `{ name: "$pages" }`, the page cache's `EVERYTHING`, which re-runs no
  live query and crosses a bus as it always has. A `touches` entry may be `ALL`, and a service in
  `flushAll` invalidates it once it succeeds, beside its own `touches`.
- **A client id** it never minted, or minted for another owner, is refused on the stream and on a
  subscribe with 403 `{ error: "unknown or foreign client id", code: "live.client-unknown" }`, the
  words unchanged for a browser from before the code.

Three things about the dispatcher that an app has to know:

- **A subscribe's context outlives its request.** The context `options.context(req, res)` builds
  for a subscribe is kept, and every re-check of that subscription hands it to `authorize` again,
  long after the response was sent. So it holds what identifies the caller and resolves it each
  time it is asked: a viewer memoised on it would pass every re-check, and a signed-out session
  would keep receiving patches. And it does not close over the response, which has ended by then:
  a header written through it throws, and the kept context holds that response in memory for as
  long as the subscription lives.
- **Who is calling.** A service reads its caller from `this`, and every call the framework makes
  says what kind of call it is, under `CALL_KIND` (`live-protocol.js`), a symbol nothing a request
  carries can set: `"direct"` for a request (a JSON POST, the event stream, a subscribe, and the
  `authorize`, `identify` and `touches` functions they run), `"preload"` for a server render's
  preload, `"live"` for a live query's run, `"render"` for a call a server render makes that nobody
  preloaded (only without `requirePreload`), and `"internal"` for the server's own work, a job that
  calls a service with `internal(reason)`. `callKind(thisValue)` reads it, and answers `"direct"` for
  anything that does not say, so a call that does not say what it is counts as a stranger's. A
  request's context is the one `options.context(req, res)` built, marked by the dispatcher whatever
  it says about itself (in place when it can be, behind a wrapper that inherits its fields when it is
  frozen or claims another kind); with none, or one that returns nothing, the dispatcher's own. The
  framework's own contexts are frozen and carry nothing but the kind (and an internal call's
  `reason`), so nothing a service reads from one names a caller. An app that passes the viewer as an
  argument, so that a live query stays a pure function of its arguments, trusts that argument on
  `"preload"` (the server chose it, from the session) and `"live"` (`authorize` matched it to the
  session with a request's context) alone. `tests/framework/context-invariant.test.mjs` holds every
  path to its kind.
- **What an invalidation names.** A target, in `touches` or in `handler.invalidate(targets)`, is a
  query name or `{ name }` (every group of that query), `{ name, args }` (the groups whose
  arguments match position by position, compared as strings), `{ name, where: { … } }` (the groups
  whose first argument has those fields), or `{ name, where: (args) => … }`. All but the last are
  data and cross a bus to the other instances. An `undefined` slot in `args` matches any argument
  on the instance that invalidates, but not after a bus: JSON carries it as `null`.

#### `server/http.js`

**Exports:** `parseCookies`, `serializeCookie`, `appendSetCookie`, `clientIp`, `onThisSite`,
`readBody`, `CACHE_CONTROL`, `pack`, `send`, `sendFile`.

The HTTP pieces a server writes around its pages and services, from Node's own modules only; what a
deployment decides is passed in.

- `parseCookies(header)` answers every cookie it can read, in an object with no prototype, and skips
  one it cannot decode (or a part with no name) instead of throwing: the header carries every cookie
  any site on the domain set, and one malformed `%`-escape must not fail every request from that
  browser.
- `serializeCookie(name, value, { path, httpOnly, sameSite, secure, expires, maxAge })` writes one
  Set-Cookie value with the value `%`-encoded and the attributes in a fixed order; given nothing it
  is `Path=/; HttpOnly; SameSite=Lax; Secure`, and a name that is not a token, a path with `;`,
  SameSite=None without Secure, a bad date or a fractional Max-Age throws rather than being written.
  `appendSetCookie(res, cookie)` adds one beside any already set.
- `clientIp(req, { trustProxy })` is the socket's address unless a proxy is trusted, and then the
  right-most `X-Forwarded-For` entry (`{ hops: n }`: the n-th from the right), which the proxy wrote
  and the client cannot choose; behind one proxy that replaces the header with the address it saw,
  that is the same address a left-most read gives.
- `onThisSite(location)` says whether a location that came with the request (a `to`, a `next`) is a
  path on this site, by the URL parser the browser will use: `/\t/elsewhere.example` and
  `/\\elsewhere.example` name another host and are refused, as is anything that is not a string
  starting with one `/`. The dispatcher's form answers use it; so should a server's own redirects.
- `readBody(req, { limit })` answers the body as a Buffer, or `null` once it passes the limit (a
  megabyte unless told), counted as it arrives.
- `pack(text, { status, gzip })` gzips a body once (`gzip: false` keeps no gzip, `gz` is `null`,
  for bytes that are compressed already; `send` then answers with the bytes whatever the client
  accepts) and names it with a weak ETag from its length and the
  first 128 bits of its SHA-256, so one body has one tag on every instance and every Node, and a
  changed body a new one even at the same length. `send(req, res, entry, { type, cache, headers })` answers
  gzip or the bytes by Accept-Encoding, always with `Vary: Accept-Encoding`, and a 304 that repeats
  the ETag, Cache-Control and Vary; `headers` are the caller's own, on both answers, and never
  replace the ones it writes.
- `sendFile(req, res, path, { type, cache, size, headers })` streams a file with `Accept-Ranges`,
  and reads a Range header as RFC 9110 does: one byte range (`first-last`, `first-`, or `-N` for the
  last N bytes, the whole file when it is shorter) is 206 with those bytes, an end past the file
  clamped to it; a first at or past the end, a suffix of 0, or a last before its first is 416;
  anything else (another unit, several ranges, a malformed header) is ignored and the whole file
  sent, as RFC 9110 allows. The unit is matched in any case. The file is read through
  `stream.pipeline`, so it is closed however the answer ends: a client that goes away mid-download
  (a video seeking cuts the download it no longer wants) no longer leaves the read stream, and its
  file descriptor, open until the process runs out of them.
- `cache` names a policy in `CACHE_CONTROL` (`no-store`; `private`, `private, no-cache`; `public`,
  revalidated on every use; `immutable`, a year), `private` unless told, so a response nobody
  classified is never kept by a shared cache; a name not there throws before anything is written.

#### `server/modules.js`

**Exports:** `createModuleServer`, `listModules`.

`createModuleServer({ root, dev, build, mounts, assets, rootFiles, static, minify })` serves an
app's browser modules with no build step, and is what keeps a rolling deploy from mixing builds. It
returns `{ handle(req, res, url), versioned(path), codeId, clear() }`. What is served is declared
once.

- **Mounts.** `mounts` is a list of `{ url, dir, depth, only }`: the files of `dir` (relative to
  `root`, a path or a `file:` URL) under the URL prefix `url`, `depth` levels of subdirectories
  down (0 unless told), with the extensions in `only` (`[".js"]` unless told). Those are `.js`, a
  module, typed and import-stamped, and `.css`, a stylesheet, typed, and nothing else: any other
  extension, `.mjs` included, would be sent `text/plain`, which a browser will not run as a module,
  with an import of it left unstamped, so construction refuses it in a mount's `only` and in an
  asset alike. Names are plain (letters, digits, `_`, `-`), so no URL walks out of its directory.
  A mount's `dir` is inside `root`, or construction refuses it, unless the mount says `outside:
  true`: for modules an app installs beside itself rather than in its own tree (plug-ins in a
  folder the installation owns, while the app is a package nothing writes to), whose `dir` may then
  be anywhere. The refusals about `src/` below hold for it all the same.
  `assets` are single files served the same way, such as a stylesheet and the browser entry.
- **The framework's own `src/`.** The flat `src/*.js` is always mounted at `/src/`, and never a
  subdirectory of it, so `src/server/` is never served; a mount inside `src/`, or above it and deep
  enough to reach it, is refused at construction, as is a mount at `/src/`. So is an asset or a root
  file whose file is inside `src/`, by the file and not only by its URL: an app that vendors the
  framework has it somewhere other than `<root>/src` (`<root>/lib/juris/src`, say), where a URL
  outside `/src/` could otherwise name Node-only code, or a flat framework file under a second URL.
- **The boot snapshot.** In production every file the mounts and assets name is read once, at
  construction, and served from memory: an instance started before a deploy changed the files goes
  on serving what it started with, including a file the deploy removed, and a file the checkout
  gained since is a 404 (`no-store`), never the next build's code stamped with this build's code
  id; `versioned` refuses such a file too.
- **Root files.** `rootFiles` maps a fixed URL to a file (`"/manifest.webmanifest":
  "public/manifest.webmanifest"`) or to `{ file, type, headers }` (`"/sw.js": { file:
  "public/sw.js", headers: { "service-worker-allowed": "/" } }`): files a browser finds by name,
  such as a service worker and a manifest, which live at the root so that their scope is the whole
  site. They are not modules: sent as they are on disk, never stamped or minified, with no `?v` and
  no part in the code id, always `no-cache`, typed by extension unless `type` says, with the
  headers given (never `content-type` or `cache-control`). Production snapshots them with the
  modules, since they change what an installed app does, and one missing at start refuses
  construction. A URL a mount or asset also serves is refused.
- **Static files.** `static` is what a site serves that is not its code, such as fonts, pictures and
  a library vendored byte for byte: `{ url, dir, depth, only }` serves a directory's files with
  those extensions (`only` is required), as a mount does, and `{ url, file }` one file at one URL;
  each says how long a browser may keep it, `immutable: true` for a name that changes whenever the
  file does (a font's, a vendored folder that carries its version), or `maxAge` in seconds (0,
  revalidated on every use, unless told). Names may carry dots but start with a letter, a digit, `_`
  or `-`. A static file goes out as it is on disk, never stamped or minified, typed by its extension
  unless `type` says (an extension with no known type and no `type` is refused); text is gzipped for
  a browser that asks and varies by encoding, while a font or a picture goes one way (and is never
  gzipped at all: it was, on its first request, which stalled the event loop and kept it twice); its
  ETag names its bytes, and a 304 repeats the ETag and Cache-Control. Static files are not modules:
  no `?v`, no part in the code id, and not in the snapshot: production reads each the first time it
  is asked for and keeps it (so mid-roll an instance may serve the new checkout's copy, which a
  versioned name makes harmless), and development reads the disk every time; a declared name with no
  file behind it is a 404. Construction refuses an entry that is malformed, outside the root, under
  `/src/` or reaching `src/`, or that would answer a URL a mount, an asset, a root file or another
  entry answers.
- **The code id and the stamps.** `codeId` is a hash of the snapshot, `build` and the transform (the
  module server's own version, which moves with any change to its stamper or the framework's
  minifier, and whether production minifies and with what: a custom minifier by its functions'
  source text), so a URL changes exactly when the bytes served under it can: a server upgraded under
  the same build and files once served new bytes under URLs browsers had kept as immutable for a
  year. A custom minifier whose source text stays the same while its behaviour changes (a wrapper
  around a library that was upgraded) needs a new `build`. `versioned(path)` is the path with
  `?v=<content hash>-<code id>`, for the tags an app writes itself. Every import a served module
  makes is stamped `?v=<code id>`: relative specifiers, and absolute ones under a mount or naming a
  module asset, in every form a browser follows (after `from` in an import or a re-export, in a
  side-effect `import "x"`, and as `import(…)`'s first argument, with options or without), however
  the source spaces them, so each module has one URL and one instance (one form left unstamped is a
  module loaded twice: a dynamic import of an absolute path once was). Only code is read
  (`jsTokens`, `server/minify.js`): a string, a comment, a regex or a template that spells an import
  is left as it is, and `import()`'s argument is stamped as a string or as a template with no
  substitution (`` import(`./b.js`) ``), which was left unstamped and loaded under a second URL. An
  `import()` inside a template's substitution is stamped. Any other specifier that is not a literal
  cannot be stamped. An asset imported this way gets the code id alone, not the URL `versioned`
  gives it, so the browser entry is loaded by the page and never imported.
- **Serving.** `handle(req, res, url)` answers a URL the mounts or assets name and returns `true`,
  and returns `false` for any other, which is the app's: a name with no file behind it is a 404 that
  says nothing else; JS is stamped, and in production minified once per file (`minify: { js, css }`,
  the framework's minifier unless told, `false` for none); the answer is `immutable` only when `?v`
  names this process's own code id, `public` (revalidated on every use) under any other, and
  `no-store` in development, where nothing is snapshotted, minified or kept: every request reads the
  file from disk and stamps it again, so what a browser gets is what is on disk now. `clear()`
  forgets what production built, and in development has nothing to forget.
- `listModules({ root, mounts, assets })` lists every file the mounts and assets name, as
  `{ url, file }`, for an app's own checks (a test that minifies everything it serves).

#### `server/document.js`

**Exports:** `renderDocument`, `inlineScriptHashes`.

`renderDocument({ html, json }, options)` writes the whole HTML document around a server-rendered
page: the doctype, `<html lang>` with the app's `htmlAttrs`, a head the app describes as data, the
body's markup in `#app`, the state as JSON in `#state`, the callable service names in `#services`
when given `serviceNames` (a list of strings), and a module script that, once the page has loaded
and the browser is idle, imports `entry` and calls its `start()` ("The page contract"; `rootId` and
`stateId` rename the first two).

- **The head** is written in a fixed order, and only what is given: `<meta charset="utf-8">`,
  `viewport` (`width=device-width, initial-scale=1` unless told, `null` for none), `title`,
  `description`, `canonical`, `links` and `meta` (each an object of attributes, written in its own
  order; `true` is a bare attribute), `buildMeta: { name, content }` (the build that wrote the page,
  for a browser that asks whether the server has moved on), `preload` (`<link rel="preload">`),
  `styles` (`{ text }` an inline `<style>`, `{ href }` a stylesheet), and last `trustedHead`.
- **Every value is escaped** where it is written, with `ssr-renderer.js`'s `escapeText` and
  `escapeAttribute`, as the body is: a title is text, whoever wrote it. `entry` is written as a JSON
  string with `<` escaped, and so is any `<` in the state and in the service names. `trustedHead`
  alone is written as given: markup, for the app's own inline scripts (one that sets the theme
  before the first paint), so nothing a request carries belongs in it.
- **What escaping cannot make safe throws** instead: an attribute name `html-safety.js` refuses
  (`on…`, or anything that is not a name), a URL attribute whose scheme it refuses, a `rel` on a
  preload or a stylesheet (the framework writes those), `</style` in a style's text, and `</script`
  or `<!--` in `devReload`, the development reload client's source, which goes in a script at the
  end of the body, and a `<meta http-equiv="refresh">` whose URL part (after the delay, `;` or `,`,
  an optional `url=` and quote) has a scheme the URL rules refuse (`javascript:`, `vbscript:`,
  `data:`, anything unknown).
- **The loader** uses `requestIdleCallback` only when it is a function (`typeof`), so an element
  with `id="requestIdleCallback"` cannot stand in for it where the browser has none.
- `inlineScriptHashes(document)` answers the CSP source of every script the document runs inline
  (`'sha256-…'`, quoted as a policy writes it): the loader, and the reload client in development;
  never the JSON blocks, which run nothing. A hash, not a nonce, because a page a cache shares is one
  set of bytes for every reader. The page pipeline's `headers` hook is given them.

#### `server/dev-reload.js`

**Exports:** `devReload`.

`devReload({ root, restartOn, reloadOn, onRestart, onReload, watch })` returns `{ script, handle,
close }`: in development, a server that restarts itself when code it runs changes, and reloads the
pages open on it when only what browsers load changed.

- A server loads its code once, so the only reload that gives it new code is a new process, and the
  framework never touches `process`: `onRestart(file)` (required) is the app entry's, and starts the
  successor and lets this process go. It is called once; nothing this process hears after it
  counts.
- The framework's own directory (`src/`, `src/server/` inside it) is always watched, and so is
  whatever `restartOn` names; `reloadOn` names what only browsers load (a stylesheet, the browser
  entry), and a change there runs `onReload(file, { clients })` first, for the app to move its build
  id and drop what it built from the old files, then tells every open page to reload.
- Paths are relative to `root` (a path or a `file:` URL); one that does not exist, or is outside
  the root, is refused when the reloader is made, before anything is watched. A directory is watched
  recursively, so a folder made in it later is covered; a file is watched through its directory, by
  name, so a save that writes a copy and renames it over the file counts every time. Changes are
  gathered until 150 ms pass without one, and a burst that touched anything `restartOn` covers
  restarts, whatever else it touched and in whatever order. A watcher that fails counts as a change
  to what it watched.
- `script` is the page's client, for `renderDocument`'s `devReload`: it listens at `/__reload`, a
  fixed path, and reloads on an explicit `reload` event, or when the `build` event it hears on
  connecting names another process than the one it heard first; each reloader names its own process
  with a random id, never the app's build, which an app may pin across a restart.
  `handle(req, res, url)` answers `/__reload` with that event stream and returns `true`, and `false`
  for any other URL. `close()` ends the open streams and stops watching. `watch` replaces
  `fs.watch`, for a test.

#### `server/page-cache.js`

**Exports:** `decide`, `createPageCache`, `EVERYTHING`, `canonicalPath`, `pageCacheKey`.

The rendered-page cache, and the policy for what goes in it. It knows nothing of HTTP or a database,
and what it is told (who the viewer was, the status) is the app's to say.

- `decide(trace, { viewer, unkeyedRoots, status })` reads a traced render (`renderRequest({ trace:
  true })`) and refuses a page rendered for a viewer, a 404, a render whose preloaded call failed
  (the trace's `failed`: that request's failure, not the page; `put` then leaves the page kept
  before it as it was and hands a stale page's replacement back), a render that drew a component
  nobody registered (the trace's `unknown`: a page missing a part), a render a plugin flagged
  volatile, and one that read a state root the URL does not carry (`unkeyedRoots`). A render in
  which no reactive function ran and nothing was called is kept until the cache is cleared; one that
  read preloaded data is kept until a change names one of its services, or until its TTL, after
  which it is served stale while one caller renders it again.
- `createPageCache({ unkeyedRoots, ttlMs, staleMs, maxEntries, maxQueryEntries, invalidatable, onWarn,
  now })` holds the pages in a bounded LRU: take `snapshot()` before a render, and `put` refuses a
  page whose services were invalidated while it rendered, and any page, a static one too, rendered
  across an `EVERYTHING` invalidation or a `clear()`; `invalidate(targets)` takes the targets a
  change bus carries, and `EVERYTHING` (`"$pages"`) or a target it cannot read drops every page.
  Pages whose key carries a query hold a share of it (`maxQueryEntries`, a quarter of `maxEntries`
  unless told): the key keeps a parameter pages read with whatever value a visitor sends, so once
  they hold their share a new one takes the room of the least recently used of them, never of a page
  without a query. `stats()` counts them (`queryEntries`) beside the rest.
- `canonicalPath(url)` is the one spelling of a path a server redirects to before its guards, its
  cache key and its render read it (dot segments resolved in any spelling, `\` read as `/`), and
  `pageCacheKey(url, known)` keeps only the query parameters pages read.

#### `server/minify.js`

**Exports:** `minifyJs`, `minifyCss`, `jsTokens`.

What a server sends browsers in production, made smaller and nothing else. Conservative by design:
`minifyJs` removes comments, indentation and blank lines, collapses each run of whitespace to one
character (a newline when the run held any of JavaScript's line terminators, `\r`, U+2028 and
U+2029 included, which also end a line comment), and never looks inside a string, a template's text
or a regular expression, so token boundaries and semicolon insertion come out as written; it never
renames or folds anything. Whether a `/` begins a regex is read from the token before it and the
brackets open around it: after the `)` of an `if`, `while`, `for` or `with` head and after a block's
`}` a regex may follow; after an expression's `)`, an object literal's `}` or a property named like
a keyword (`x.return`), it is division. `jsTokens(src)` is that reading, as tokens whose texts
joined are the source (the module server's import stamping reads it too). One case is read wrong,
and no one writes it: division right after a function or class expression's `}` ("Open").
`minifyCss` also drops whitespace around `{};:,>` where it cannot matter and the `;` before a `}`
(never inside a string), keeps the space before a colon wherever it was written (a descendant
combinator, at the top level, in `@media` or nested in a rule), and drops a comment, leaving a space
only between two characters of a name or a number (`.a/**/.b` is `.a.b`, as a browser reads it;
`0/**/auto` is `0 auto`). Its cases are in `tests/framework/server.test.mjs`.

#### `server/db.js`

**Exports:** `fromPg`, `fromMysql2`, `fromMariadb`.

One interface over the database drivers a server may use, so an app's services and a change bus
never see a driver's return shape. `db.query(sql, params = [])` answers the rows of a statement that
returns rows (for one that does not, what the driver reports); `db.transaction(fn)` runs
`fn({ query })` on one connection between BEGIN and COMMIT, answers what `fn` returns, rolls back
and rethrows when `fn` or the COMMIT fails (a failed rollback does not replace that error), and
releases the connection either way, unless the ROLLBACK itself failed: then the connection may still
be inside the transaction, so it is destroyed rather than pooled (pg: `client.release(error)`;
mysql2 and mariadb: `conn.destroy()`), and the pool opens a new one. The rows also say their
columns, in order, as `rows.fields` (the names; pg and mysql2), a property that is not enumerable, so
the rows iterate and serialize as before; a statement that returns no rows still has them, which is
how a caller learns the shape of an empty result. The driver is the app's: it passes a pool in, so
the module imports nothing and the framework depends on no driver.

#### `server/bus/pg-outbox.js`

**Exports:** `createPgOutboxBus`, `schemaFor`, `SCHEMA`, `CHANGE_TABLE`, `CHANNEL`,
`PRUNE_AFTER_MS`, `emit`, `writeWithChanges`.

A change bus for `serviceDispatcher`'s `live.bus` on Postgres, so an invalidation on one instance
reaches the live queries and pages of every other.

- An outbox table is the record, and a trigger's `NOTIFY`, sent at commit, is only the doorbell:
  each instance reads the rows it has not seen, and a slow sweep catches what a missed notification
  would lose. Ids are taken at INSERT and seen at COMMIT, so a transaction can commit a lower id
  after a higher one: the reader re-checks exactly the ids it jumped over until they appear or leave
  the lookback window.
- `createPgOutboxBus({ pool, targets, sweepMs, coalesceMs, lookbackMs, batchSize, table, channel,
  onError, now, origin, reconnectMs, reconnectMaxMs })` answers the bus, which the dispatcher is
  given as `live.bus` and the app starts (`start()`) and stops (`stop()`): `targets` maps an entity
  to the invalidation targets its change means, and `origin` marks the rows this bus writes, so it
  skips its own echo. `publish(targets)` writes a row after a mutation; `emit(tx, entity, entityId,
  table)` writes one inside the mutation's own transaction, and `writeWithChanges(db, fn, table)`
  runs a mutation and its notices in one transaction, so the notice commits with the data or not at
  all.
- The LISTEN connection is the bus's own. When it is lost, the bus opens it again after
  `reconnectMs` (500), and keeps trying, the wait doubling up to `reconnectMaxMs` (30000), until it
  is back or the bus is stopped, then reads at once (it used to try once, so a database that took
  longer to come back left the bus on the sweep for good). A client whose `LISTEN` fails is released
  with the error, which destroys it, instead of staying checked out. A `start()` that fails rejects
  and leaves the bus stopped, so calling it again tries again (it used to do nothing). Each failed
  attempt counts in `stats().errors` and `lastErrorAt`, its words to `onError`.
- `schemaFor({ table, channel })` writes the table, its index, the notify function and the trigger,
  all named after the table, with the channel defaulting to the table's name as the bus's own does,
  so a bus and a schema given only the table meet; `SCHEMA` is `schemaFor()`, the default names,
  `CHANGE_TABLE` and `CHANNEL` (`change_events`). A table or channel must be a lowercase SQL
  identifier, and `schemaFor` and the bus both refuse anything else: the trigger's
  `pg_notify('<channel>')` sends the name exactly as written while the bus's unquoted `LISTEN` folds
  it to lowercase, so a capital would ring one channel and listen on another.
- `prune({ olderThanMs })` deletes the rows written more than that long ago (`PRUNE_AFTER_MS`, an
  hour, unless told) by the database's own clock, and answers how many: the table is what to tell
  the other instances, not history, and nothing else deletes from it, so an app runs it on a timer.
  Less than the bus's `lookbackMs` is refused, since a younger row may be one a reader has not read
  yet.
- `stats()` counts what the bus did, and a failed read as `errors` and `lastErrorAt` (the bus's
  clock): when, never what. The driver's words go to `onError` alone, since an app may show
  `stats()` in a public `/healthz`. The pool is the app's, so the module imports only `../db.js`.

#### `server/bus/mysql-outbox.js`

**Exports:** `createOutboxBus`, `schemaFor`, `SCHEMA`, `CHANGE_TABLE`, `PRUNE_AFTER_MS`, `emit`,
`writeWithChanges`.

The same bus on MariaDB or MySQL, `createOutboxBus({ db, targets, intervalMs, … })`, over an adapter
from `db.js` (`fromMysql2`, `fromMariadb`). Neither database has `NOTIFY`, so it polls (every 25 ms
by default). Same table, same rows, same re-checks, the same `emit` and `writeWithChanges`, and the
same `schemaFor({ table })` (a plain identifier, capitals allowed: with no channel, nothing sends
the name one way and reads it another), `SCHEMA` and `prune({ olderThanMs })`, whose cutoff is
`NOW(3)`: a DATETIME carries no zone, so the process's clock is never compared with it. Its
`stats()` keeps a failed poll's time (`lastErrorAt`), never its words, as the Postgres bus does. A
full batch is followed by the next poll only once it has been delivered, so no two polls run at
once and `stop()` resolves with none running (the next one used to be let in while the first still
awaited delivery).

The buses' names are shared by every instance that reads the table, old builds included while a
deploy is half rolled: the table, its index, the notify function, the trigger and the channel
(`change_events`, and names made from it), the payload of a published row (`{ o, t }`: the
publishing bus and its targets), and the page cache's `$pages` target that crosses in it. Their
defaults do not change, and a bus given another table or channel reaches only the instances given
the same.

### What the server and the browser are given alike

`createJurisServer` and `hydrate` each build the page's `Juris` instance, so what an app wants of it
beyond the defaults goes to both as one option, `juris`:
`{ allowTags, allowSchemes, allowInnerHTML }`, the tags and URL schemes both renderers draw beyond
the ones they allow (`html-safety.js`), and whether a layout may set `innerHTML` (a boolean, off
unless given). Both check it with the one function, `sharedOptions` in `juris.js`: a plain object of
those keys only, each value as `Juris` itself would take it, anything else refused with a
`TypeError` before anything is built or read (the kernel before it builds its instance, the boot
before it reads the page). Nothing else of the instance is the app's to set through it: `isServer`,
`requirePreload`, the state and the services are the kernel's and the boot's. The rule is that both
sides read it from **one module both import**, the way an app shares its routes and its title
(`app/hello` keeps them in `client/app.js`, which its server's entry and its browser's entry both
import): `export const juris = { allowSchemes: ["magnet"] }` beside them, and
`createJurisServer({ …, juris })`, `hydrate({ …, juris })`. Given to one side only, a tag, a scheme
or `innerHTML` is drawn by the server and taken away when the page boots, or refused by the server
and drawn once it boots. `tests/framework/shared-options.js` is such a module, and the kernel's
suite and the browser suite each hold what they draw with it to the same markup. The document's
head is not a layout and is checked against the defaults alone (`renderDocument`).

### A route's own code

An app that sends each page's components in a module of its own, fetched when needed, puts
`load(juris)` on the route record: whatever has to happen before the route can be drawn (fetch the
module, register its components). With `register(module, juris)` beside it, `load()` answers the
page's module (`() => import("./pages/x.js")`) and the router registers it: once per module on each
instance, so the routes that share a module share its register, which runs for whichever reaches it
first; a register that throws has its error thrown again to every later load of that module, so a
half-registered module never looks loaded.

The router awaits every matched record's `load` before it writes the location, on `navigate()` and
on Back and Forward alike, so the page being left stays up until the next one can draw. It never
draws a component that is not registered yet: that renders as an unknown element, and `RouterView`
does not draw it again when the component registers, so the page would stay blank. Each record's
`load` runs once per router, so once per instance; one that fails is tried again on the next
navigation. A newer navigation, or Back or Forward, supersedes one still loading.

If `load` throws or rejects (a module that does not arrive, a register that throws), the router
loads the address in full instead: it makes the address the tab's entry (pushed, replaced, or the
entry Back or Forward reached), marks that entry in `history.state`, and calls the router's
`fullLoad(url)` option, which reloads by default. An entry that already carries the mark for that
address is not loaded in full again, so a page whose code keeps failing cannot loop. On a server,
where there is no page to load, the navigation rejects with the error instead. A server loads every
route's code up front with `router.loadAll()` (on the instance the router is installed on, record by
record in the table's order, rejecting with the first failure); `createJurisServer` does so once
`setup` has run.

### One server instance, every request

A server renders all its pages with one `Juris` instance, and `renderRequest` keeps the requests
apart by replacing the state between them (`clearState`). What the framework holds to, so that no
request reads another's:

- `api.peek` is an untracked read, not an invisible one. In a traced render
  (`renderRequest({ trace: true })`) the path it read is in the trace's `paths` and `roots`, as a
  `getState`'s is, so a server that keeps pages under their URL can refuse a page that read a root
  the URL does not name.
- `callCache` (`dedupe`, `ttl`) is a browser cache. A server instance refuses it at construction,
  because a result kept for one visitor, or a call of theirs still in flight, would be the answer to
  the next visitor's identical call. `clearState` empties it on any instance.
- The async error logs (`$async.errors`, and each group's `errors`, which `Await`'s `onError` draws)
  belong to the request that produced them: `clearState` drops them (in a browser it keeps the
  in-flight counters beside them; on a server it resets those too, below). On a server their
  messages pass `exposeError`, as a failed preload's do, so a driver's words are kept as "request
  failed"; in a browser a message is kept as it is, because it came from the page's own code or from
  a server that has already filtered it.
- The async counters belong to the request too. On a server `clearState` resets them, each group's
  included (a server render awaits nothing between `clearState` and `serializeState`, so nothing of
  the last request is in flight), and a promise counted before it settles into nothing: a promise
  one request tracked, or one that never settles, used to keep every later request's `Await` on its
  fallback. A browser carries its counters across a clear, as before.
- A preloaded answer and the state a request is rendered with are the request's own copies (see
  `juris.js`), so a service's cached object is never written by a render, nor carried into the next
  request's page.
- A service is found by name among the instance's own `services` only (`api.call`, `api.live`, a
  preload). A name every object inherits, such as `constructor` or `toString`, is an unknown
  service, as it is to the dispatcher.

### Local state

`api.useState(key, initial)` returns `[get, set]` for a slot in the state tree,
`$local.<Component>.<n>.<key>` (the `localPath` option renames the root), where `n` is the
instance's place among that component's instances in render order. The instance that called
`useState` owns the slot: its shape, when it changes and when it goes away. The pair is the whole
interface. Code that reads or writes another component's slot by its path has taken a dependency
the owner does not know about, and it breaks on a change the owner was entitled to make; a
component that wants another's state asks for a prop or a shared path instead. The slot is
nonetheless an ordinary state path, on purpose: that is how its value crosses from a server render
into the browser, how a test drives a component without its DOM, and how devMode's
`componentTree()` reads it. So the rule is one for review, not a mechanism. It follows that
`$local` is serialised into the page with the rest of the state, so nothing secret goes in it.

## What the framework stores in a browser

What the framework stores in a browser is declared in `storage.js`: `STORAGE`, frozen, one entry
per key as `{ key, kind, category, purpose, life }`, which an app that lists what it stores (a cookie
notice) spreads into its own list rather than keeping a copy (JR-F12: a key the framework wrote
was once missing from such a list). Today that is one `sessionStorage` key, the router's trail
length, `trailKey({ routePath, base })`: `juris:<routePath>:length` (`juris:$route:length` under the
router's default root), with the base in it when the app is mounted under one
(`juris:/app:$route:length`), so two apps under two bases in one tab keep two trails.

- The router writes it on every page it runs in, so that after a reload the tab still knows how far
  Forward can go; its `history` option is `{ storage, key }` (sessionStorage and that key unless
  told) or `false`, which stores nothing and keeps the trail in the page's memory. An entry the
  router has not marked is a fresh one (the tab came to the address anew), where a stored length is
  not believed: what lay ahead of it is gone. `api.canBack()` and `api.canForward()` say, tracked,
  whether the trail goes anywhere (false on a server).
- The skew guard of `client.js` writes one more key, when an app turns it on, under the key the app
  gives it, which is the app's to declare.
- Nothing else in `src/` writes browser storage or a cookie today. The router also keeps its own
  fields in `history.state` on the entries it makes: the entry's place in the trail (`juris`,
  `idx`) and, after a failed `load`, the address it loaded in full (`fullLoad`). Those belong to the
  tab's history entries and go with them; a replace keeps whatever else is on the entry, and a new
  entry carries nothing of the last one's.

## The browser floor

Juris is written for Safari and iOS Safari 15.4, Chrome and Edge 93, Firefox 92, and anything newer
(no suite runs in a browser at that floor: it is read from the features `src/` uses). The floor is
set by the newest feature `src/` relies on, `Object.hasOwn` (in `juris.js`, `router.js` and
`errors.js`); everything else it uses (`??=`, optional chaining, module scripts, dynamic
`import()`) is older. There is no build step to translate newer code for an older browser, so a
module that uses something newer fails to link or to run there, and the page stays the server's
page, readable and not live.

- **Nothing newer than the floor in a top-level `src/*.js`.** `tests/framework/boundary.test.mjs`
  (its rule 6) refuses the newer features most likely to be reached for: an array's `toSorted` and
  `with`, `Object.groupBy`, `Promise.withResolvers`, `structuredClone` (Chrome and Edge 98, Firefox
  94), an array's `findLast` (Chrome and Edge 97, Firefox 104), `crypto.randomUUID` (Firefox 95), a
  class static block, a lookbehind in a regular expression, `URL.canParse`, the new `Set` methods,
  and the others it lists. A feature it does not list is review's to catch, in all three engines:
  a feature Safari 15.4 has can still be newer than Chrome 93 or Firefox 92, as those three are.
- `Array.prototype.at` and `replaceChildren` are within the floor. A lower floor would mean
  replacing `Object.hasOwn` first.
- `requestIdleCallback`, which Safari at the floor lacks, is used only where a timer stands in for
  it (`client.js` and the document's loader).
- Raising the floor is a change to this section first, then to the test's list.

The Node half runs, and is tested here, on Node 24; the repository declares Node 20 or newer, and no
test holds that lower bound.

## Security defaults and invariants

What the framework promises about safety, where the code is that keeps each promise, and the test
that fails when it breaks. Where a rule closed a finding of the framework review, its id is given
(`JR-…`); the finding's full record (how it was found, and what it let through) is kept with the
repository that carries Juris.

### The defaults

These are the boundary's rule 4. All six are the framework's own, and an app that wants less says so
in its own code.

| Default | Held by | Test |
| --- | --- | --- |
| An error's message is denied unless the error was written for its reader (`error.expose === true`, which `ServiceError` sets) (JR-F5). | `defaultExposeError`, `mayExpose` and `publicMessage` in `errors.js`; the default of the dispatcher's, the kernel's and, on a server, `Juris`'s own `exposeError` (a failed preload, the async error logs). | `tests/framework/errors.test.mjs`, `tests/framework/service-errors.test.mjs`, `tests/framework/server.test.mjs` |
| Unsafe tags (`style` and `plaintext` among them), `innerHTML`, style keys and values that are not one property's value, and URL schemes are refused, on both sides; an element already there is taken for a layout only when its tag would be drawn, and `enhance` refuses to adopt one whose tag is refused; an app names what it adds (`juris`: `allowTags`, `allowSchemes`, `allowInnerHTML`). | `html-safety.js` (`checkTag`, `checkInnerHTML`, `checkStyle`, `classTokens`, `reusableElement`, `checkAttribute`), both renderers. | `tests/framework/html-safety.test.mjs`, `tests/framework/juris-hardening.test.mjs`, the browser suite's "URL schemes: allowSchemes", `tests/framework/render.test.mjs` |
| A live query needs `authorize` or `public: true`. | `serviceDispatcher`, at construction. | `tests/framework/juris-hardening.test.mjs` |
| Every value written into a document is escaped, apart from the one slot an app marks trusted (JR-F1). | `renderDocument`. | `tests/framework/document.test.mjs` |
| A personal page is never cached, and goes out `private, no-cache` (`no-store` in development). | `createPagePipeline` (never keeps a page rendered for a viewer, never serves a viewer the guests' copy), and `decide`, which refuses such a page on its own. | `tests/framework/kernel.test.mjs`, `tests/framework/page-cache.test.mjs` |
| Cluster workers are refused beside live queries. | `startProcess` refuses to fork them; `createJurisServer` refuses to serve in one, unless the app says `allow` (`allowWorkers`). | `tests/framework/process.test.mjs`, `tests/framework/server.test.mjs` |

What stays the app's is saying who the viewer is, through the page's `viewer(req, url)` hook: one
that names nobody makes every page a guest's, public and kept when there is a cache. Outside pages,
`send` and `sendFile` answer `private, no-cache` unless the caller names another policy.

### The invariants

**Requests and responses** (`server/kernel.js`, `server/http.js`, `server/page-cache.js`)

- Nothing a request carries ends the instance, and nothing that throws is shown to it: a target no
  URL can be made of is a 400 (JR-F14), and anything that throws is a fixed 500 whose body says
  nothing, the error going to the log (JR-F3); `/healthz` fails with a fixed body too.
  `tests/framework/lifecycle.test.mjs`.
- A malformed cookie is skipped, never thrown (JR-F4), and a cookie is written with safe defaults or
  refused. `tests/framework/http.test.mjs`.
- A path has one spelling: `canonicalPath` redirects any other (dot segments in any spelling, `\`)
  before the guard, the cache key or the render reads it (JR-F13), and the canonical link is encoded
  (JR-F2). `tests/framework/page-cache.test.mjs`, `tests/framework/kernel.test.mjs`.
- A page is answered in one fixed order (path, viewer, guard, `before`, cache, render, answer), and
  nothing runs inside a render: `renderRequest` awaits nothing between `clearState` and
  `serializeState`, and every hook runs before or after it, so two requests on the one instance
  never see each other's state. A guard is a pure function of the route and who is asking.
  `tests/framework/kernel.test.mjs` ("guards are pure: two viewers' requests through one instance
  never see each other's verdict").
- What a request's own failure shaped is never kept, so a guest cannot fill the cache with it and
  push real pages out: a 404 (no route, or a subject that is not there) and a render whose preloaded
  call failed, which goes out as a 200 and leaves the page kept before it as it was. What a guest
  can fill it with, one page per value of a parameter pages read, holds a share of the cache
  (`maxQueryEntries`) and pushes out only its own kind. `tests/framework/kernel.test.mjs`,
  `tests/framework/page-cache.test.mjs`.
- A kept page is evicted by every change to what it read: the route's own call is in its trace
  whatever its body calls, and a page rendered across an `EVERYTHING` invalidation or a `clear()` is
  not put. A viewer's page is never put, so it never evicts the guests' copy.
  `tests/framework/server.test.mjs`.
- A cacheable page is rendered from its cache key, so no visitor's query parameters reach another
  (JR-C10). `tests/framework/kernel.test.mjs`.
- An ETag names its content on every Node (JR-C7), and a Range header is read as RFC 9110 reads it
  (JR-C8). `tests/framework/http.test.mjs`. A file sent is closed however the answer ends, a client
  that goes away included. `tests/framework/server.test.mjs`.
- `listen` binds the loopback address unless told; the drain ends the live and reload streams
  first, lets requests finish within a bound, stops the jobs, and closes what they used last
  (JR-C9); a misspelt option is refused, at the top and inside an option that takes its own.
  `tests/framework/server.test.mjs`, `tests/framework/dispatcher.test.mjs`,
  `tests/framework/lifecycle.test.mjs`, `tests/framework/sse-client.test.mjs`. The drain also waits
  for the stale pages' replacements under way and begins none; a wait Node cannot keep (a job's
  `every`, `health.timeoutMs`, `closeTimeoutMs`) is refused when it is given; and a job never runs
  beside itself. `tests/framework/server.test.mjs`.
- On a server, `clearState` resets the async counters, and a preloaded answer or a request's state
  is copied, so no request's data or pending work reaches another. `tests/framework/core.test.mjs`.

**Services and live queries** (`server/service-dispatcher.js`, `live-protocol.js`, `errors.js`)

- JSON only (415 otherwise): the defence against cross-site requests. The form path keeps its own
  rules (the allow-list, same origin, 16 KiB, the error filter, a redirect on the same site) and runs
  a call's `touches` as a JSON call does (JR-C1). `tests/framework/dispatcher.test.mjs`.
- A malformed service name is a 400, and a context that throws refuses rather than escaping
  (JR-F6). Only the names the dispatcher was built with are callable. A refusal's `field` reaches
  the caller (JR-C5). `tests/framework/juris-hardening.test.mjs`,
  `tests/framework/service-errors.test.mjs`. A refusal's status is an HTTP error status Node knows
  (500 otherwise); a service that succeeded runs its `touches` whatever becomes of its answer; a
  form upload cut short runs nothing and is a 400. `tests/framework/live.test.mjs`.
- `authorize` runs on subscribe, on a direct POST to a declared query, and on re-check, with the
  context captured at subscribe; `invalidateAccess` re-asks and never drops blindly, on the local
  instance (JR-F8), and always asks, whatever `recheckMs` is.
  `tests/framework/juris-hardening.test.mjs`, `tests/framework/live.test.mjs`.
- With `strictQueries`, only declared queries can be subscribed. Client ids are minted by the server
  and bound to `identify`. `tests/framework/dispatcher.test.mjs`, `tests/framework/live-bus.test.mjs`.
- One socket per client id; a stream abandoned during `identify`, or a client dropped during
  `authorize`, leaves nothing behind. Every number `live` takes is checked at construction, so no
  ceiling is off by a string. `tests/framework/live.test.mjs`.
- Every call says its kind, and a call that does not say is a stranger's; a live query does not read
  the session (JR-C13). `tests/framework/context-invariant.test.mjs`.
- One caller cannot hold every live query or unlimited streams
  (`tests/framework/juris-hardening.test.mjs`). A stream more than `maxBufferBytes` behind is
  dropped; that is held by the code alone, with no test yet.
- `diff` treats a dotted, `__proto__` or empty key as data, a `Date` as a leaf, and deletes a
  removed key whatever its name. `tests/framework/juris-hardening.test.mjs`,
  `tests/framework/live.test.mjs`.
- A bus's `stats()` keeps when a read failed, never the driver's words.
  `tests/framework/lifecycle.test.mjs`.
- A bus publish never delays this instance's own re-runs, and what arrives off the bus does not
  wait for them; the Postgres bus reopens a lost LISTEN until it is back, and the MySQL bus never
  runs two polls at once. A connection whose ROLLBACK failed is destroyed, never pooled; a live
  query whose result JSON cannot carry fails as a failed re-run. `tests/framework/live.test.mjs`.

**Rendering and the browser** (`juris.js`, `html-safety.js`, both renderers, `router.js`, `client.js`)

- Both renderers refuse the same tags, attribute names (`on…`) and URL schemes (after stripping
  control characters), and `srcdoc` outright; `enhance` refuses `innerHTML` anywhere in an enhanced
  subtree unless told. `tests/framework/juris-hardening.test.mjs`, `tests/framework/html-safety.test.mjs`.
  `innerHTML` is refused unless the instance allows it; `plaintext` and `style` are refused tags; a
  `style` object's keys and values and a `classList` key are held to one rule on both sides
  (`checkStyle`, `classTokens`); an element that is already there is reused only for a tag the
  renderers would draw, and `enhance` never writes into one of a refused tag.
  `tests/framework/render.test.mjs`.
- A `<meta http-equiv="refresh">` URL is held to the scheme rules, and neither the document's loader
  nor the client boot is fooled by an element named `requestIdleCallback`.
  `tests/framework/render.test.mjs`, `tests/framework/core.test.mjs`.
- On a server, a service is one of the instance's own, `callCache` is refused, `clearState` drops
  the async error logs, and `peek` is traced (JR-F11). `tests/framework/juris-round3.test.mjs`.
- `privatePaths` are never serialised, and `serializeState` escapes `<`; `requirePreload` throws on
  a call that was not preloaded, and the trace flags the render `unresolved`. The browser suite's
  "Shared services and api.call", `tests/framework/ssr-trace.test.mjs`.
- The router keeps an undecodable segment as it arrived, and `parseQuery` builds an object with no
  prototype. `tests/framework/juris-hardening.test.mjs`.
- No target the router answers names another host: a backslash is a slash, and a path has exactly
  one leading slash (`resolve`'s redirect, `resolveTarget`, `link().href`).
  `tests/framework/core.test.mjs`.
- `clearState` skips an own `__proto__` key in the state it is given, so a parsed state cannot set
  the root's prototype; `privatePaths`, `asyncPath` and `routePath` name roots, and a nested one is
  refused rather than matching nothing. `tests/framework/core.test.mjs`.
- The page's state is read only from the server's JSON script (JR-F15). The browser suite's "Client
  boot: hydrate".
- A page is named the same on both sides (JR-C3), and a route's code is loaded before its page is
  drawn (JR-C4). The browser suite's "Router".
- What the framework stores in a browser is declared (JR-F12). `tests/framework/readme.test.mjs`
  holds this file to `STORAGE`.
- A form's own `onblur` keeps touch tracking on, and a double click submits once (JR-C14). The
  browser suite's "Forms: api.form". An `onSuccess` that fails leaves the submit a success, and
  `reset()` frees a form whose submit never answered; a stub's call times out (408), and a 2xx that
  is not JSON rejects. `tests/framework/core.test.mjs`.
- A live path says whether what it shows is current (`liveState`), alike on the server and in the
  browser's first render. `tests/framework/core.test.mjs`.

**Modules and processes** (`server/modules.js`, `server/process.js`, `server/dev-reload.js`)

- `src/server/` is never served: the mount rule, and refusals at construction by the file a mount,
  an asset, a root file or a static entry names. `tests/framework/modules.test.mjs`.
- A module is `immutable` only under this process's own code id, and has one URL; production serves
  only its snapshot. The server alone writes that header: a proxy that adds a Cache-Control of its
  own defeats it. `tests/framework/modules.test.mjs`. The code id moves with the transform (the
  stamper, the minifier, whether production minifies), and only specifiers in code are stamped, a
  template given to `import()` included; the minifier reads a regex and a division as code does, and
  every line terminator as one. `tests/framework/server.test.mjs`.
- Cluster workers are refused before anything forks. `tests/framework/process.test.mjs`. A worker
  that keeps dying is replaced after a wait that doubles, never in a loop.
  `tests/framework/live.test.mjs`.
- Development reload watches `src/` recursively (JR-C11), and the kernel refuses it outside
  development. `tests/framework/dev-reload.test.mjs`, `tests/framework/server.test.mjs`.

### Open

These are known, and not closed:

- **Layout branding.** Tags are checked, but a row from data that reaches a child position can
  still name a registered component (`{ SomeComponent: { … } }`) and instantiate it with the row's
  props. Closing it needs a brand on every layout that JSON cannot forge. It is latent while no app
  renders raw rows as children.
- **CSS from data.** A `style` string, or an allowed value in a style object, can still make the
  browser fetch a URL (`background: url(…)`): a value cannot end its declaration or start another,
  but `url()` is a value. A `style` string is written as given on both sides. Build styles from
  objects with known keys.
- **`!important` in a style object's value.** The server writes it and the DOM drops it on
  assignment, so the two sides differ by those characters. It cannot add a declaration; the one
  rule (`checkStyle`) could refuse `!` if the two should agree to the character.
- **An allowed `<script>`'s text is escaped by the server.** With `allowTags: ["script"]`, the
  server renderer escapes a script's text as it does any text (`a < b` goes out as `a &lt; b`,
  which breaks the script), as it once did a `<style>`'s. A script's raw-text rules (`</script`,
  `<!--`, `<script`) are subtler than a style's; the document writer's are the model if it is wanted.
- **The minifier misreads one case.** Division right after a function or class expression's `}`
  (`f = function () {} / 2`) is read as the start of a regex. No one writes it.
- **A custom minifier is known by its source text.** The code id names it by its functions' source,
  so a wrapper whose behaviour changes while its text stays the same (a library it calls was
  upgraded) keeps the code id, and browsers keep the old bytes as immutable, unless the app moves
  `build`.
- **An unsendable answer is a 400.** A service result JSON cannot carry is answered with the
  refusal's default status; a 500 would describe it better, and is a change of answer not yet made.
- **No per-viewer channel.** Data that belongs to one reader needs a live query group of its own.
- **A Content-Security-Policy is the app's to write.** The pipeline hands its `headers` hook the
  hashes of the page's inline scripts; what else a page may load is the app's knowledge. Juris sets
  inline `style` attributes in server-rendered markup, so a policy needs `style-src 'unsafe-inline'`.
- **Taking live access away reaches only the instance that acted** (JR-F8's remainder): another
  instance stops a signed-out reader's patches at its next re-check, before the first patch it
  would send once `recheckMs` (30 s) has passed since the last.
- **A guest's ceiling is per address.** The default `clientKey` counts a guest by address, so many
  guests behind one address share the twelve streams one caller may hold.
- **The module server compares paths as written, not real paths.** An app that passes `root`
  through a symlink, or reaches the framework through one, gets none of the refusals that keep
  `src/` from being served twice or `src/server/` at all.

## Not yet

These are gaps between what this file describes and what a framework ready for other people would
have, stated so nobody reads them as done:

- **The fixes are not yet proven in production.** Juris runs two real-time sites in production and
  `app/hello`. The sites work around the issues fixed in this version (F1–F27) and are being moved
  to it (see "Where it stands").
- **Signing in is the app's.** A request context, a session cookie, and the rule for when a viewer
  argument is believed are written by each members app ("Your first app").
- **The kernel does not wire a page cache itself.** A cache is taken only beside a dispatcher the
  app built and wired to it (`live.onInvalidate`).
- **The MySQL and MariaDB bus is not verified in this checkout.** Its suite
  (`tests/framework/live-bus.test.mjs`, which needs a reachable MariaDB and the `mysql2` driver) and
  the Postgres bus's (`tests/framework/pg-bus.test.mjs`) belong to the suite the framework was
  reviewed with, which this checkout does not carry. The Postgres bus runs here every day under the
  app's own pipeline (`npm run test:all`), not under a framework test.
- **No bundling** means more module requests, and browsers download the server renderer ("The code
  a browser runs is the file on disk").
- **A split boot mid-deploy** can leave a page not live until its next full load ("A rolling deploy
  mixes two builds").
- The other open findings above.
- **One release's leftovers.** `renderRequest`'s `cache`, `meta.title` and `meta.titleFrom` in place
  of `head`, `remoteServices`' string base, and `sseClient`'s reading of a refusal's words where it
  carries no code are kept for one more release, and then removed. `remoteServices`' reading of a
  2xx answer that is not JSON as `{ error }` is not among them: it is gone, and such an answer
  rejects (`response.not-json`).
- **Some fixes are held in Node only.** The render and core suites reach the browser's side through
  a stand-in DOM, a fake `window` and `history` and a fake `EventSource`, and this checkout carries
  no browser suite at all: `innerHTML`, `classList`, `style` and `xlink:` in a real DOM, a keyed
  component with no element root, `enhance` over a refused tag, the loader and the boot in a browser
  without `requestIdleCallback`, the router's boot and hash mode, `Link`'s bound `href` and the live
  status over a real stream are checked in a real browser only through the app's own checks.
- **No version number and no changelog.** There is one repository and one version until Juris is
  extracted into a repository of its own; a number before then would be decoration.
- **No package of its own.** `src/` itself uses no package, and `tests/framework/` runs on the app's
  `node_modules` (`pg`). The extraction check ("The boundary": `src/` and `tests/framework/` copied
  away and run on their own) is not a script of this checkout; `tests/framework/boundary.test.mjs`
  holds what it can of the boundary in place. A package that declares its own, and a repository whose
  own test run is that check, come with extraction.
- **The browser floor is held against a list** of newer features, not by parsing what each module
  uses.
