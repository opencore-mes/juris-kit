# Juris

A framework for server-rendered web apps whose pages stay live.

- **Every page is rendered whole on the server**, so it can be read before any script runs; the
  browser then makes that same page interactive.
- **Live queries keep it up to date.** A service says which queries it touches; after it runs, the
  server runs those queries again and sends each page that watches them only what changed.
- **No build step, no runtime dependency.** The code a browser runs is the file on disk; a database
  driver is something the app passes in.
- **Layouts are plain objects**, the same on both sides: `{ h1: { textContent: () => api.getState("title") } }`.

Node 24 or later. Apache-2.0.

```bash
npm install @opencore-mes/juris-kit
```

## A whole app

Five files: the app (the same on the server and in the browser), its services, the server, its
start, and the browser's entry.

`client/app.js`: its routes and components.

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

`services.js`: what the app does. A refusal is written for the person reading it.

```js
import { fail } from "@opencore-mes/juris-kit/errors.js";
export const services = {
    async greeting(name) {
        if (typeof name !== "string" || !name.trim()) fail("Say who to greet.", { fields: { name: "Required." } });
        return { text: `Hello, ${name.trim().slice(0, 60)}` };
    },
};
```

`app.mjs` and `server.mjs`: the server, and the one file that touches the process.

```js
import { createJurisServer } from "@opencore-mes/juris-kit/server/kernel.js";
import { routes, register, title } from "./client/app.js";
export const createApp = ({ services, dev = false, build = "dev" }) => createJurisServer({
    root: new URL(".", import.meta.url), dev, build, services, routes, setup: register,
    api: { live: { public: true, queries: ["greeting"], touches: {} } },
    modules: { mounts: [{ url: "/client/", dir: "client" }], entry: "/client/boot.js" },
    page: { title },
});

// server.mjs
import { createApp } from "./app.mjs";
import { services } from "./services.js";
const app = await createApp({ services, dev: true });
const { url } = await app.listen({ port: 3000 });
console.log(`listening on ${url}`);
```

`client/boot.js`: the browser's entry. The framework's own files are served at `/src/`.

```js
import { hydrate } from "/src/client.js";
import { routes, register, title } from "./app.js";
export const start = () => hydrate({ routes, register, title });
```

On a request for `/`, the server runs the route's `preload` calls, renders `Home` from their
answers, and writes the page with the state it rendered from. In the browser, `hydrate` takes over
that page, and `api.live` subscribes to `greeting` over the page's one event stream.

## Where things are imported from

| Where | Import | For |
| --- | --- | --- |
| The browser's entry | `/src/client.js` | `hydrate`, the whole client boot |
| Shared modules, when they need it | `/src/forms.js`, `/src/clock.js`, `/src/live-data.js`, `/src/router.js`, `/src/errors.js`, `/src/storage.js` | Plugins and helpers, in the browser |
| The server | `@opencore-mes/juris-kit/server/kernel.js` (`createJurisServer`), `.../server/process.js` (`startProcess`) | The whole server, and starting it |
| Services | `@opencore-mes/juris-kit/errors.js` | `fail` |
| Beside the kernel | `.../server/page-cache.js`, `.../server/bus/pg-outbox.js`, `.../server/db.js`, `.../server/dev-reload.js`, `.../server/http.js` | A page cache, a change bus, a driver adapter, development reload, cookies |

A component reaches Juris through its `api` and imports nothing of it, so only an app's entry
points name where Juris lives.

## The full reference

[REFERENCE.md](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md) is the framework's
contract: everything an app may use, what the framework promises, what holds each promise, and what
is not there yet. It ships in the package too (`node_modules/@opencore-mes/juris-kit/REFERENCE.md`).

- [Why it is built this way](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md#why-it-is-built-this-way)
- [The boundary](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md#the-boundary): what may go in the framework, and the test that holds it
- [The page contract](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md#the-page-contract): `#app`, `#state`, `#services` and `start()`
- [Reserved state roots](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md#reserved-state-roots): `$route`, `$ssr`, `$local`, `$async`, `$server`, `$live`
- [The public API](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md#the-public-api): components, the component api, and every module
- [The browser floor](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md#the-browser-floor): Safari 15.4, Chrome 93, Firefox 92
- [Security defaults and invariants](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md#security-defaults-and-invariants)
- [Not yet](https://github.com/opencore-mes/juris-kit/blob/main/REFERENCE.md#not-yet)

Juris runs [OpenCore MES](https://opencoremes.com), its largest user. Its tests are in `tests/`
(`npm test`). Issues and changes: [github.com/opencore-mes/juris-kit](https://github.com/opencore-mes/juris-kit).
