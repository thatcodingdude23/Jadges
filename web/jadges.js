(() => {
  const dataElement = document.getElementById("jadges-data");
  if (!dataElement) return;

  let state;
  try {
    state = JSON.parse(dataElement.textContent || "{}");
  } catch {
    return;
  }

  const grid = document.getElementById("badge-grid");
  const preview = document.getElementById("profile-badges");
  const saveIndicator = document.getElementById("save-indicator");
  const sideButtons = [...document.querySelectorAll("[data-side]")];
  let draggingKey = null;
  let draggingCategory = null;
  let saveQueue = Promise.resolve();
  let lastCustomProfileStatusKey = "";
  let customProfilePollTimer = 0;

  const CUSTOM_PROFILE_MESSAGES = {
    pending: "your custom profile is now waiting for approval",
    denied: "your custom profile has been denied",
    approved: "your custom profile has been accepted",
  };

  function setSaveState(text, isError = false) {
    if (!saveIndicator) return;
    saveIndicator.classList.toggle("error", isError);
    const label = saveIndicator.querySelector("span:last-child");
    if (label) label.textContent = text;
  }

  function movableBadges() {
    const byKey = new Map(state.badges.map((badge) => [badge.key, badge]));
    return state.order.map((key) => byKey.get(key)).filter(Boolean);
  }

  function displayedBadges() {
    const pinned = state.badges.filter((badge) => !badge.movable);
    return [...pinned, ...movableBadges()];
  }

  function catalogueBadges() {
    return Array.isArray(state.catalogBadges) ? state.catalogBadges : [];
  }

  function categoryFor(badge) {
    return badge.key.startsWith("discord:") ? "native" : "jadges";
  }

  function categoryKeys(category) {
    const byKey = new Map(state.badges.map((badge) => [badge.key, badge]));
    return state.order.filter((key) => {
      const badge = byKey.get(key);
      return badge && categoryFor(badge) === category;
    });
  }

  async function save(patch) {
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
      setSaveState("Saving changes…");
      const response = await fetch("/api/dashboard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patch),
      });

      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }

      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not save your changes");
      state = body;
      setSaveState("All changes saved");
      render();
    }).catch((error) => {
      setSaveState(error instanceof Error ? error.message : "Could not save", true);
      throw error;
    });

    return saveQueue;
  }

  function moveBadge(key, offset, category) {
    const keys = categoryKeys(category);
    const index = keys.indexOf(key);
    const targetKey = keys[index + offset];
    if (index < 0 || !targetKey) return;

    const currentPosition = state.order.indexOf(key);
    const targetPosition = state.order.indexOf(targetKey);
    if (currentPosition < 0 || targetPosition < 0) return;

    const previous = [...state.order];
    [state.order[currentPosition], state.order[targetPosition]] = [
      state.order[targetPosition],
      state.order[currentPosition],
    ];
    render();
    void save({ order: state.order }).catch(() => {
      state.order = previous;
      render();
    });
  }

  function createGrip() {
    const grip = document.createElement("span");
    grip.className = "badge-grip";
    grip.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 6; i += 1) grip.append(document.createElement("i"));
    return grip;
  }

  function createBadgeCard(badge, movableIndex, movableCount, category) {
    const catalogOnly = badge.catalogOnly === true;
    const card = document.createElement("article");
    card.className = `badge-card${badge.movable ? "" : " pinned"}${catalogOnly ? " catalog-only" : ""}`;
    card.dataset.key = badge.key;
    card.dataset.category = category;
    card.dataset.movable = String(badge.movable && !catalogOnly);
    card.dataset.manageable = String(!catalogOnly);
    card.draggable = badge.movable && !catalogOnly;

    if (catalogOnly) {
      const label = document.createElement("span");
      label.className = `catalog-label catalog-label-${badge.catalogKind === "bot" ? "bot" : "unowned"}`;
      label.textContent = badge.catalogKind === "bot" ? "Bot badge" : "Not owned";
      card.append(label);
    } else if (badge.movable) {
      card.append(createGrip());
    } else {
      const pin = document.createElement("span");
      pin.className = "pin-label";
      pin.textContent = "Official";
      card.append(pin);
    }

    const imageWrap = document.createElement("div");
    imageWrap.className = "badge-image-wrap";
    const image = document.createElement("img");
    image.className = "badge-image";
    image.src = badge.image;
    image.alt = "";
    image.loading = "lazy";
    imageWrap.append(image);

    const name = document.createElement("div");
    name.className = "badge-name";
    name.textContent = badge.name;
    name.title = badge.name;

    const kind = document.createElement("div");
    kind.className = "badge-kind";
    kind.textContent = badge.subtitle;

    card.append(imageWrap, name, kind);

    if (badge.movable && !catalogOnly) {
      const controls = document.createElement("div");
      controls.className = "badge-move";

      const previous = document.createElement("button");
      previous.type = "button";
      previous.textContent = "←";
      previous.title = "Move earlier";
      previous.setAttribute("aria-label", `Move ${badge.name} earlier`);
      previous.disabled = movableIndex <= 0;
      previous.addEventListener("click", () => moveBadge(badge.key, -1, category));

      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "→";
      next.title = "Move later";
      next.setAttribute("aria-label", `Move ${badge.name} later`);
      next.disabled = movableIndex >= movableCount - 1;
      next.addEventListener("click", () => moveBadge(badge.key, 1, category));

      controls.append(previous, next);
      card.append(controls);
    }

    card.addEventListener("dragstart", (event) => {
      if (!badge.movable || catalogOnly) return;
      draggingKey = badge.key;
      draggingCategory = category;
      card.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", badge.key);
      }
    });

    card.addEventListener("dragend", () => {
      draggingKey = null;
      draggingCategory = null;
      card.classList.remove("dragging");
      document.querySelectorAll(".badge-card.over").forEach((item) => item.classList.remove("over"));
    });

    card.addEventListener("dragover", (event) => {
      if (
        catalogOnly
        || !badge.movable
        || !draggingKey
        || draggingKey === badge.key
        || draggingCategory !== category
      ) return;
      event.preventDefault();
      card.classList.add("over");
    });

    card.addEventListener("dragleave", () => card.classList.remove("over"));

    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("over");
      if (
        catalogOnly
        || !badge.movable
        || !draggingKey
        || draggingKey === badge.key
        || draggingCategory !== category
      ) return;

      const from = state.order.indexOf(draggingKey);
      const to = state.order.indexOf(badge.key);
      if (from < 0 || to < 0) return;

      const previousOrder = [...state.order];
      [state.order[from], state.order[to]] = [state.order[to], state.order[from]];
      render();
      void save({ order: state.order }).catch(() => {
        state.order = previousOrder;
        render();
      });
    });

    return card;
  }

  function createCategory(category, title, description, badges) {
    const section = document.createElement("section");
    section.className = `badge-category-section badge-category-${category}`;

    const header = document.createElement("div");
    header.className = "badge-category-header";
    const copy = document.createElement("div");
    copy.className = "badge-category-copy";
    const heading = document.createElement("h3");
    heading.textContent = title;
    const detail = document.createElement("p");
    detail.textContent = description;
    copy.append(heading, detail);

    const count = document.createElement("span");
    count.className = "badge-category-count";
    count.textContent = `${badges.length} badge${badges.length === 1 ? "" : "s"}`;
    header.append(copy, count);

    const categoryGrid = document.createElement("div");
    categoryGrid.className = "badge-category-grid";

    if (badges.length === 0) {
      const empty = document.createElement("div");
      empty.className = "badge-category-empty";
      empty.textContent = category === "native"
        ? "Open your Discord profile with Jadges enabled to detect native badges."
        : category === "catalog"
          ? "More Discord badges will appear here as Jadges encounters them."
          : "No Jadges badges are available yet.";
      categoryGrid.append(empty);
    } else if (category === "catalog") {
      for (const badge of badges) categoryGrid.append(createBadgeCard(badge, -1, 0, category));
    } else {
      const movableKeys = categoryKeys(category);
      for (const badge of badges) {
        const index = badge.movable ? movableKeys.indexOf(badge.key) : -1;
        categoryGrid.append(createBadgeCard(badge, index, movableKeys.length, category));
      }
    }

    section.append(header, categoryGrid);
    return section;
  }

  function renderGrid() {
    if (!grid) return;
    grid.replaceChildren();
    grid.classList.add("badge-category-layout");

    const badges = displayedBadges();
    const jadgesBadges = badges.filter((badge) => categoryFor(badge) === "jadges");
    const nativeBadges = badges.filter((badge) => categoryFor(badge) === "native");
    const catalog = catalogueBadges();

    grid.append(
      createCategory(
        "jadges",
        "Jadges badges",
        "Official, uploaded, and equipped Nitro badges managed through Jadges.",
        jadgesBadges,
      ),
      createCategory(
        "native",
        "Your native Discord badges",
        "Badges currently belonging to your Discord account.",
        nativeBadges,
      ),
      createCategory(
        "catalog",
        "Other Discord badges",
        "Bot badges and Discord badges that are not currently on your account. These are view-only.",
        catalog,
      ),
    );
  }

  function renderPreview() {
    if (!preview) return;
    preview.replaceChildren();
    for (const badge of displayedBadges()) {
      const item = document.createElement("span");
      item.className = "preview-badge";
      item.dataset.key = badge.key;
      item.title = badge.name;
      const image = document.createElement("img");
      image.src = badge.image;
      image.alt = badge.name;
      item.append(image);
      preview.append(item);
    }

    if (!preview.children.length) {
      const text = document.createElement("span");
      text.style.color = "#68758f";
      text.style.fontSize = "11px";
      text.textContent = "Your badges will appear here";
      preview.append(text);
    }
  }

  function renderSide() {
    for (const button of sideButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.side === state.side));
    }
    const positionValue = document.getElementById("position-value");
    if (positionValue) positionValue.textContent = state.side === "left" ? "Left" : "Right";
  }

  function render() {
    renderGrid();
    renderPreview();
    renderSide();
  }

  function ensureCustomProfileAlertStyles() {
    if (document.getElementById("custom-profile-alert-styles")) return;
    const style = document.createElement("style");
    style.id = "custom-profile-alert-styles";
    style.textContent = `
      .custom-profile-alert-stack{position:fixed;top:22px;right:22px;z-index:10000;display:grid;gap:12px;width:min(390px,calc(100vw - 32px));pointer-events:none}
      .custom-profile-alert{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:13px;padding:15px 16px;border:1px solid;border-radius:14px;box-shadow:0 18px 55px rgba(0,0,0,.38);backdrop-filter:blur(18px);font-weight:800;line-height:1.35;pointer-events:auto;animation:custom-profile-alert-in .2s ease-out}
      .custom-profile-alert::before{content:"";width:10px;height:10px;border-radius:999px;box-shadow:0 0 0 5px currentColor;opacity:.75}
      .custom-profile-alert.pending{background:rgba(58,49,15,.96);border-color:#927c27;color:#ffe386}
      .custom-profile-alert.denied{background:rgba(58,18,24,.97);border-color:#a33a45;color:#ff9da7}
      .custom-profile-alert.approved{background:rgba(15,53,34,.97);border-color:#2e8a57;color:#91efb5}
      .custom-profile-alert button{border:0;background:transparent;color:inherit;font:inherit;font-size:20px;line-height:1;cursor:pointer;opacity:.8}
      @keyframes custom-profile-alert-in{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}
      @media(max-width:650px){.custom-profile-alert-stack{top:12px;right:12px;width:calc(100vw - 24px)}}
    `;
    document.head.append(style);
  }

  function customProfileAlertStack() {
    ensureCustomProfileAlertStyles();
    let stack = document.querySelector(".custom-profile-alert-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "custom-profile-alert-stack";
      stack.setAttribute("aria-live", "polite");
      document.body.append(stack);
    }
    return stack;
  }

  function showCustomProfileAlert(status, message) {
    const stack = customProfileAlertStack();
    const alert = document.createElement("div");
    alert.className = `custom-profile-alert ${status}`;
    alert.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = message;
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss notification");
    close.textContent = "×";
    close.addEventListener("click", () => alert.remove());
    alert.append(document.createElement("span"), text, close);
    stack.append(alert);
    window.setTimeout(() => alert.remove(), 10000);
  }

  function setCustomProfileInlineStatus(text, isError = false) {
    const indicator = document.getElementById("custom-profile-status");
    if (!indicator) return;
    indicator.classList.toggle("error", isError);
    const label = indicator.querySelector("span:last-child");
    if (label) label.textContent = text;
  }

  async function refreshCustomProfileStatus(showWhenUnchanged = false) {
    try {
      const response = await fetch("/api/custom-profile/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (response.status === 401) return;
      if (!response.ok) throw new Error("Could not load status");
      const body = await response.json();
      const request = body && body.request;
      if (!request || !request.id || !request.status) return;
      const key = `${request.id}:${request.status}`;
      if (!showWhenUnchanged && key === lastCustomProfileStatusKey) return;
      lastCustomProfileStatusKey = key;
      const status = request.status === "approved" ? "approved" : request.status === "denied" ? "denied" : "pending";
      const message = CUSTOM_PROFILE_MESSAGES[status];
      setCustomProfileInlineStatus(
        status === "pending" ? "Waiting for approval" : status === "approved" ? "Accepted" : "Denied",
        status === "denied",
      );
      showCustomProfileAlert(status, message);
    } catch {
      // Status polling should never interrupt the rest of the dashboard.
    }
  }

  function startCustomProfilePolling() {
    if (customProfilePollTimer) return;
    void refreshCustomProfileStatus(true);
    customProfilePollTimer = window.setInterval(() => {
      if (location.hash === "#customprofile") void refreshCustomProfileStatus();
    }, 3500);
  }

  async function submitCustomProfile(username, createdAt) {
    setCustomProfileInlineStatus("Submitting…");
    const response = await fetch("/api/custom-profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, createdAt }),
    });
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setCustomProfileInlineStatus(body.error || "Could not submit", true);
      throw new Error(body.error || "Could not submit custom profile");
    }
    lastCustomProfileStatusKey = `${body.requestId}:pending`;
    setCustomProfileInlineStatus("Waiting for approval");
    showCustomProfileAlert("pending", CUSTOM_PROFILE_MESSAGES.pending);
  }

  function setupCustomProfileApproval() {
    document.addEventListener("submit", (event) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (!form || form.id !== "custom-profile-form") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const username = document.getElementById("custom-profile-username")?.value || "";
      const createdAt = document.getElementById("custom-profile-date")?.value || "";
      void submitCustomProfile(username, createdAt).catch((error) => {
        showCustomProfileAlert("denied", error instanceof Error ? error.message : "Could not submit custom profile");
      });
    }, true);

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("#custom-profile-clear") : null;
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const username = document.getElementById("custom-profile-username");
      const createdAt = document.getElementById("custom-profile-date");
      if (username) username.value = "";
      if (createdAt) createdAt.value = "";
      username?.dispatchEvent(new Event("input", { bubbles: true }));
      createdAt?.dispatchEvent(new Event("input", { bubbles: true }));
      void submitCustomProfile("", "").catch((error) => {
        showCustomProfileAlert("denied", error instanceof Error ? error.message : "Could not submit custom profile");
      });
    }, true);

    window.addEventListener("hashchange", () => {
      if (location.hash === "#customprofile") {
        startCustomProfilePolling();
        void refreshCustomProfileStatus(true);
      }
    });

    if (location.hash === "#customprofile") startCustomProfilePolling();
  }

  for (const button of sideButtons) {
    button.addEventListener("click", () => {
      const side = button.dataset.side;
      if (!side || side === state.side) return;
      const previous = state.side;
      state.side = side;
      renderSide();
      void save({ side }).catch(() => {
        state.side = previous;
        renderSide();
      });
    });
  }

  setupCustomProfileApproval();
  render();
})();
