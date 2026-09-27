const handlers = {};
const leaveHandlers = {};
let current = null;

export function on(name, fn) {
  handlers[name] = fn;
}

// Called when the active route changes *away from* `name`, so a route can
// release what it owns (the project shell tears its state down for the library).
export function onLeave(name, fn) {
  leaveHandlers[name] = fn;
}

function parse() {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1]) {
    return { name: "project", params: { id: decodeURIComponent(parts[1]) } };
  }
  return { name: "library", params: {} };
}

export function navigate(name, params) {
  if (name === "project") {
    location.hash = `#/p/${encodeURIComponent(params.id)}`;
  } else {
    location.hash = "#/";
  }
}

export function currentRoute() {
  return current;
}

export function start() {
  const apply = () => {
    const route = parse();
    if (
      current &&
      route.name === current.name &&
      route.params.id === current.params.id
    ) {
      return;
    }
    if (current && current.name !== route.name && leaveHandlers[current.name]) {
      leaveHandlers[current.name]();
    }
    current = route;
    const fn = handlers[route.name] || handlers.library;
    fn(route.params);
  };
  window.addEventListener("hashchange", apply);
  apply();
}
