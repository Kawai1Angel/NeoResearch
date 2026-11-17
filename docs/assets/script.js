"use strict";
document.documentElement.classList.add("js");

// Values reproduced from Table 1 of docs/NeoResearch_arXivs.pdf.
const benchmarkData = [
  {
    "dataset": "ETTh1",
    "mse": {
      "baseline": 0.1022,
      "ours": 0.1004,
      "methods": [
        "iTransformer"
      ]
    },
    "mae": {
      "baseline": 0.2436,
      "ours": 0.2434,
      "methods": [
        "iTransformer"
      ]
    }
  },
  {
    "dataset": "GEF-L",
    "mse": {
      "baseline": 0.3384,
      "ours": 0.3324,
      "methods": [
        "AIDE"
      ]
    },
    "mae": {
      "baseline": 0.4119,
      "ours": 0.4114,
      "methods": [
        "AIDE"
      ]
    }
  },
  {
    "dataset": "Windy",
    "mse": {
      "baseline": 1.2785,
      "ours": 1.3406,
      "methods": [
        "DLinear"
      ]
    },
    "mae": {
      "baseline": 0.7946,
      "ours": 0.7867,
      "methods": [
        "ARIMA"
      ]
    }
  },
  {
    "dataset": "Sunny",
    "mse": {
      "baseline": 0.3119,
      "ours": 0.3089,
      "methods": [
        "DLinear"
      ]
    },
    "mae": {
      "baseline": 0.3598,
      "ours": 0.3552,
      "methods": [
        "TimeMixer"
      ]
    }
  },
  {
    "dataset": "MOPEX",
    "mse": {
      "baseline": 1.1581,
      "ours": 0.9812,
      "methods": [
        "MTGNN"
      ]
    },
    "mae": {
      "baseline": 0.6094,
      "ours": 0.5443,
      "methods": [
        "GNN"
      ]
    }
  },
  {
    "dataset": "BE",
    "mse": {
      "baseline": 1.4386,
      "ours": 1.3807,
      "methods": [
        "AIDE"
      ]
    },
    "mae": {
      "baseline": 0.4764,
      "ours": 0.4637,
      "methods": [
        "AIDE"
      ]
    }
  },
  {
    "dataset": "DE",
    "mse": {
      "baseline": 0.803,
      "ours": 0.7912,
      "methods": [
        "DeepAR"
      ]
    },
    "mae": {
      "baseline": 0.6018,
      "ours": 0.5948,
      "methods": [
        "DeepAR"
      ]
    }
  },
  {
    "dataset": "FR",
    "mse": {
      "baseline": 5.1838,
      "ours": 5.0887,
      "methods": [
        "TimeXer"
      ]
    },
    "mae": {
      "baseline": 0.7262,
      "ours": 0.6675,
      "methods": [
        "AIDE"
      ]
    }
  },
  {
    "dataset": "NP",
    "mse": {
      "baseline": 0.3842,
      "ours": 0.3546,
      "methods": [
        "TimeMixer"
      ]
    },
    "mae": {
      "baseline": 0.3786,
      "ours": 0.3618,
      "methods": [
        "PatchTST"
      ]
    }
  },
  {
    "dataset": "PJM",
    "mse": {
      "baseline": 0.2116,
      "ours": 0.1849,
      "methods": [
        "Optuna-TPE"
      ]
    },
    "mae": {
      "baseline": 0.3269,
      "ours": 0.3093,
      "methods": [
        "Optuna-TPE"
      ]
    }
  }
];

const nav = document.querySelector(".nav-links");
const menuToggle = document.querySelector(".menu-toggle");
const header = document.querySelector(".site-header");

function closeMenu() {
  nav.classList.remove("is-open");
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Open navigation");
}

menuToggle.addEventListener("click", () => {
  const open = menuToggle.getAttribute("aria-expanded") !== "true";
  nav.classList.toggle("is-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
});
nav.querySelectorAll("a").forEach(link => link.addEventListener("click", closeMenu));
document.addEventListener("click", event => {
  if (!header.contains(event.target)) closeMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && menuToggle.getAttribute("aria-expanded") === "true") {
    closeMenu();
    menuToggle.focus();
  }
});
window.matchMedia("(min-width: 621px)").addEventListener("change", closeMenu);

// Keep the current section visible in the navigation, including on deep links.
const sectionLinks = [...nav.querySelectorAll('a[href^="#"]')];
const sections = sectionLinks.map(link => document.querySelector(link.getAttribute("href")));
let scrollScheduled = false;
function updateNavigation() {
  const position = window.scrollY + header.offsetHeight + 100;
  let active = null;
  for (const section of sections) {
    if (section && section.offsetTop <= position) active = section.id;
  }
  sectionLinks.forEach(link => {
    const current = link.getAttribute("href") === `#${active}`;
    link.classList.toggle("is-current", current);
    if (current) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  header.classList.toggle("is-scrolled", window.scrollY > 12);
  scrollScheduled = false;
}
window.addEventListener("scroll", () => {
  if (!scrollScheduled) {
    scrollScheduled = true;
    window.requestAnimationFrame(updateNavigation);
  }
}, { passive: true });
window.addEventListener("resize", updateNavigation);
window.addEventListener("load", updateNavigation);
updateNavigation();

// The chart and full numeric table are present in HTML without JavaScript.
const chart = document.querySelector("#benchmark-chart");
document.querySelectorAll("[data-metric]").forEach(button => {
  button.addEventListener("click", () => {
    const metric = button.dataset.metric;
    document.querySelectorAll("[data-metric]").forEach(item => {
      item.setAttribute("aria-pressed", String(item === button));
    });
    document.querySelector("#chart-title").textContent = `Relative ${metric.toUpperCase()} reduction`;
    chart.setAttribute("aria-label", `Relative ${metric.toUpperCase()} reduction against the strongest baseline on each dataset; exact values are provided in the table below.`);
    benchmarkData.forEach((dataset, index) => {
      const reduction = 100 * (dataset[metric].baseline - dataset[metric].ours) / dataset[metric].baseline;
      const row = chart.children[index];
      row.classList.toggle("negative", reduction < 0);
      row.querySelector(".bar-fill").style.width = `${Math.abs(reduction) / 18 * 100}%`;
      row.querySelector(".bar-value").textContent = `${reduction < 0 ? "−" : "+"}${Math.abs(reduction).toFixed(1)}%`;
    });
  });
});

// Native dialog provides focus trapping, Escape, and focus restoration.
const figureDialog = document.querySelector(".figure-dialog");
if (typeof figureDialog.showModal === "function") {
  const preview = figureDialog.querySelector(".dialog-content img");
  document.querySelectorAll("[data-figure]").forEach(link => {
    link.addEventListener("click", event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      document.querySelector("#figure-dialog-title").textContent = link.dataset.figure;
      preview.src = link.href;
      preview.alt = link.querySelector("img").alt;
      figureDialog.querySelector(".dialog-original").href = link.href;
      document.body.classList.add("dialog-open");
      figureDialog.showModal();
      figureDialog.querySelector(".dialog-content").scrollTo(0, 0);
    });
  });
  figureDialog.querySelector(".dialog-close").addEventListener("click", () => figureDialog.close());
  figureDialog.addEventListener("click", event => {
    const rect = figureDialog.getBoundingClientRect();
    if (event.target === figureDialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) figureDialog.close();
  });
  figureDialog.addEventListener("close", () => document.body.classList.remove("dialog-open"));
}

// Clipboard API over HTTPS/localhost; selection fallback also supports file://.
let statusTimeout;
function showStatus(message) {
  const status = document.querySelector("#copy-status");
  clearTimeout(statusTimeout);
  status.textContent = message;
  status.classList.add("is-visible");
  statusTimeout = setTimeout(() => status.classList.remove("is-visible"), 3000);
}
async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (_) {
      // Continue with the selection fallback if clipboard permission is denied.
    }
  }
  const previousFocus = document.activeElement;
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("aria-label", "Text to copy");
  input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(input);
  input.select();
  const success = document.execCommand("copy");
  input.remove();
  previousFocus?.focus({ preventScroll: true });
  if (!success) throw new Error("Clipboard unavailable");
}
document.querySelectorAll("[data-copy]").forEach(button => {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await copyText(document.getElementById(button.dataset.copy).textContent.trim());
      showStatus(button.dataset.copy === "bibtex" ? "BibTeX copied to clipboard" : "Installation commands copied to clipboard");
    } catch (_) {
      showStatus("Copy unavailable. Select the text and copy it manually.");
    } finally {
      button.disabled = false;
    }
  });
});
