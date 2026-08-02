(() => {
  const dataElement = document.getElementById("jadges-data");
  const grid = document.getElementById("badge-grid");
  const preview = document.getElementById("profile-badges");
  const saveIndicator = document.getElementById("save-indicator");
  if (!dataElement || !grid) return;

  let initialState = {};
  try {
    initialState = JSON.parse(dataElement.textContent || "{}");
  } catch {
    initialState = {};
  }

  let hidden = new Set(
    Array.isArray(initialState.hidden)
      ? initialState.hidden.filter((key) => typeof key === "string")
      : [],
  );
  let dragging = false;
  let applying = false;
  let saveQueue = Promise.resolve();

  function setSaveState(text, isError = false) {
    if (!saveIndicator) return;
    saveIndicator.classList.toggle("error", isError);
    const label = saveIndicator.querySelector("span:last-child");
    if (label) label.textContent = text;
  }

  function barrierMarkup() {
    return `
      <span class="badge-hidden-shield" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="8.5"></circle>
          <path d="m6 6 12 12"></path>
        </svg>
      </span>
      <span class="badge-hidden-label">Hidden</span>`;
  }

  function cardKey(card) {
    return card instanceof HTMLElement ? card.dataset.key || "" : "";
  }

  function patchCards() {
    for (const card of grid.querySelectorAll(".badge-card")) {
      if (!(card instanceof HTMLElement)) continue;
      if (card.dataset.manageable === "false") {
        card.classList.remove("badge-card-hidden");
        card.removeAttribute("role");
        card.removeAttribute("tabindex");
        card.removeAttribute("aria-pressed");
        card.removeAttribute("aria-label");
        card.querySelector(".badge-hidden-overlay")?.remove();
        continue;
      }

      const key = cardKey(card);
      if (!key) continue;
      const isHidden = hidden.has(key);

      card.classList.toggle("badge-card-hidden", isHidden);
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-pressed", String(isHidden));
      card.setAttribute(
        "aria-label",
        `${isHidden ? "Show" : "Hide"} ${card.querySelector(".badge-name")?.textContent || "badge"} on profile`,
      );
      card.title = isHidden
        ? "Click to show this badge on your profile"
        : "Click to hide this badge from your profile";

      let overlay = card.querySelector(".badge-hidden-overlay");
      if (!overlay) {
        overlay = document.createElement("span");
        overlay.className = "badge-hidden-overlay";
        overlay.innerHTML = barrierMarkup();
        card.append(overlay);
      }
      overlay.setAttribute("aria-hidden", String(!isHidden));
    }
  }

  function patchPreview() {
    if (!preview) return;
    const items = [...preview.querySelectorAll(".preview-badge")]
      .filter((item) => item instanceof HTMLElement);

    items.forEach((item) => {
      const key = item.dataset.key || "";
      item.hidden = Boolean(key && hidden.has(key));
    });

    let empty = preview.querySelector(".visibility-preview-empty");
    const visibleCount = items.filter((item) => !item.hidden).length;
    if (items.length > 0 && visibleCount === 0) {
      if (!empty) {
        empty = document.createElement("span");
        empty.className = "visibility-preview-empty";
        empty.textContent = "All badges are hidden";
        preview.append(empty);
      }
    } else {
      empty?.remove();
    }
  }

  function patchAll() {
    if (applying) return;
    applying = true;
    try {
      patchCards();
      patchPreview();
    } finally {
      applying = false;
    }
  }

  async function saveVisibility(key, shouldHide) {
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
      setSaveState("Saving visibility…");
      const response = await fetch("/api/badge-visibility", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key, hidden: shouldHide }),
      });

      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }

      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not save badge visibility");
      hidden = new Set(Array.isArray(body.hidden) ? body.hidden : []);
      setSaveState("All changes saved");
      patchAll();
    });
    return saveQueue;
  }

  function toggleCard(card) {
    if (card.dataset.manageable === "false") return;
    const key = cardKey(card);
    if (!key) return;
    const previous = new Set(hidden);
    const shouldHide = !hidden.has(key);
    if (shouldHide) hidden.add(key);
    else hidden.delete(key);
    patchAll();

    void saveVisibility(key, shouldHide).catch((error) => {
      hidden = previous;
      patchAll();
      setSaveState(
        error instanceof Error ? error.message : "Could not save badge visibility",
        true,
      );
    });
  }

  grid.addEventListener("dragstart", () => {
    dragging = true;
  }, true);
  grid.addEventListener("dragend", () => {
    setTimeout(() => {
      dragging = false;
    }, 0);
  }, true);

  grid.addEventListener("click", (event) => {
    if (dragging) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".badge-move, .badge-grip, button, a")) return;
    const card = target.closest(".badge-card");
    if (!(card instanceof HTMLElement) || card.dataset.manageable === "false") return;
    toggleCard(card);
  });

  grid.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (
      !(target instanceof HTMLElement)
      || !target.classList.contains("badge-card")
      || target.dataset.manageable === "false"
    ) return;
    event.preventDefault();
    toggleCard(target);
  });

  const observer = new MutationObserver(() => patchAll());
  observer.observe(grid, { childList: true, subtree: true });
  if (preview) observer.observe(preview, { childList: true, subtree: true });

  void fetch("/api/badge-visibility", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(async (response) => {
      if (response.status === 401) {
        window.location.assign("/login");
        return undefined;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load badge visibility");
      return body;
    })
    .then((body) => {
      if (!body) return;
      hidden = new Set(Array.isArray(body.hidden) ? body.hidden : []);
      patchAll();
    })
    .catch((error) => {
      setSaveState(
        error instanceof Error ? error.message : "Could not load badge visibility",
        true,
      );
    });

  patchAll();
})();
