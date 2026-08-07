import * as theme from "./themes.js";
import * as router from "./router.js";
import * as library from "./library.js";
import * as project from "./project.js";

async function boot() {
  await theme.load();
  library.init();
  project.register();
  router.start();
}

boot();
