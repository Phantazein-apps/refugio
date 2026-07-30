// Light, dark, or whatever the system says.
//
// The theme has to be decided BEFORE the first paint, or the window flashes
// the wrong palette for a frame — which on a black-to-white switch is not
// subtle. So the actual application lives in `bootTheme()`, called by a small
// inline script in each page's <head>, ahead of any stylesheet-dependent
// layout. This module is imported afterwards only by the code that CHANGES
// the setting.
//
// Stored per machine in localStorage rather than on the server: it belongs to
// the person at this screen, it must survive the server restarting, and it
// must be readable synchronously during head execution.

const KEY = "refugio.theme";

/** @returns {"system"|"light"|"dark"} */
export function themePreference() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

/** The theme actually in force right now, with "system" resolved. */
export function resolvedTheme() {
  const pref = themePreference();
  if (pref !== "system") return pref;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Stamp the resolved theme onto <html>. Safe to call repeatedly. */
export function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}

export function setThemePreference(pref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch { /* storage disabled — the choice lasts this page */ }
  applyTheme();
}

// Following the system means following it as it changes — macOS switches at
// sunset on its own, and a window that kept yesterday's palette until it was
// reloaded would look broken rather than deliberate.
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (themePreference() === "system") applyTheme();
});

// Changing the theme in Settings must reach a chat window open in another tab.
// `storage` fires in every OTHER document of this origin, which is exactly the
// set that needs telling.
addEventListener("storage", (e) => {
  if (e.key === KEY || e.key === null) applyTheme();
});
