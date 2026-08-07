import * as theme from "./themes.js";
import * as router from "./router.js";
import * as library from "./library.js";
import * as project from "./project.js";
import { toast } from "./ui.js";

window.addEventListener("error", function (e) {
  if (e.error) {
    toast(e.error.message || "An unexpected error occurred", "error");
  }
});

window.addEventListener("unhandledrejection", function (e) {
  var msg = (e.reason && e.reason.message) || String(e.reason) || "An unexpected error occurred";
  toast(msg, "error");
});

async function boot() {
  await theme.load();
  library.init();
  project.register();
  router.start();
  setupTitleBar();
}

function setupTitleBar() {
  const bar = document.getElementById("title-bar");
  if (!bar) return;

  let tries = 0;
  let maximized = false;

  function _animateMaximize() {
    const app = document.getElementById("app");
    if (!app) return;
    const cls = maximized ? "anim-max" : "anim-restore";
    app.classList.remove("anim-max", "anim-restore");
    void app.offsetWidth;
    app.classList.add(cls);
    app.addEventListener("animationend", function h() {
      app.classList.remove("anim-max", "anim-restore");
      app.removeEventListener("animationend", h);
    });
  }

  function _doMaximize() {
    window.pywebview.api.toggle_maximize();
    maximized = !maximized;
    document.getElementById("win-maximize").textContent = maximized ? "\u2750" : "\u25a1";
    document.body.classList.toggle("maximized", maximized);
    _animateMaximize();
  }

  function init() {
    if (window.pywebview && window.pywebview.api) {
      bar.style.display = "flex";
      document.body.classList.add("has-titlebar");

      document.querySelectorAll(".resize-handle").forEach(function (h) {
        h.style.display = "block";
        h.addEventListener("mousedown", function (e) {
          e.preventDefault();
          e.stopPropagation();
          window.pywebview.api.start_resize(h.dataset.dir);
        });
      });

      document.getElementById("win-minimize").addEventListener("click", function () {
        window.pywebview.api.minimize();
      });

      document.getElementById("win-maximize").addEventListener("click", function () {
        _doMaximize();
      });

      document.getElementById("win-close").addEventListener("click", function () {
        document.body.style.transition = "opacity 0.12s";
        document.body.style.opacity = "0";
        setTimeout(function () { window.pywebview.api.close(); }, 120);
      });

      bar.addEventListener("dblclick", function (e) {
        if (e.target.closest("button")) return;
        _doMaximize();
      });

      document.addEventListener("keydown", function (e) {
        if (e.key === "F11") {
          e.preventDefault();
          window.pywebview.api.toggle_fullscreen();
        }
      });

      return;
    }
    if (++tries < 100) setTimeout(init, 50);
  }
  setTimeout(init, 50);
}

boot();
