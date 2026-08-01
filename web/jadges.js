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
  let saveQueue = Promise.resolve();

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

  function moveBadge(key, offset) {
    const index = state.order.indexOf(key);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= state.order.length) return;
    const previous = [...state.order];
    [state.order[index], state.order[target]] = [state.order[target], state.order[index]];
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

  function createBadgeCard(badge, movableIndex, movableCount) {
    const card = document.createElement("article");
    card.className = `badge-card${badge.movable ? "" : " pinned"}`;
    card.dataset.key = badge.key;
    card.dataset.movable = String(badge.movable);
    card.draggable = badge.movable;

    if (badge.movable) card.append(createGrip());
    else {
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

    if (badge.movable) {
      const controls = document.createElement("div");
      controls.className = "badge-move";

      const previous = document.createElement("button");
      previous.type = "button";
      previous.textContent = "←";
      previous.title = "Move earlier";
      previous.setAttribute("aria-label", `Move ${badge.name} earlier`);
      previous.disabled = movableIndex <= 0;
      previous.addEventListener("click", () => moveBadge(badge.key, -1));

      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "→";
      next.title = "Move later";
      next.setAttribute("aria-label", `Move ${badge.name} later`);
      next.disabled = movableIndex >= movableCount - 1;
      next.addEventListener("click", () => moveBadge(badge.key, 1));

      controls.append(previous, next);
      card.append(controls);
    }

    card.addEventListener("dragstart", (event) => {
      if (!badge.movable) return;
      draggingKey = badge.key;
      card.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", badge.key);
      }
    });

    card.addEventListener("dragend", () => {
      draggingKey = null;
      card.classList.remove("dragging");
      document.querySelectorAll(".badge-card.over").forEach((item) => item.classList.remove("over"));
    });

    card.addEventListener("dragover", (event) => {
      if (!badge.movable || !draggingKey || draggingKey === badge.key) return;
      event.preventDefault();
      card.classList.add("over");
    });

    card.addEventListener("dragleave", () => card.classList.remove("over"));

    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("over");
      if (!badge.movable || !draggingKey || draggingKey === badge.key) return;

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

  function renderGrid() {
    if (!grid) return;
    grid.replaceChildren();
    const badges = displayedBadges();
    const movable = badges.filter((badge) => badge.movable);

    if (badges.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<div><strong>No badges to arrange yet</strong><br><span>Once a badge is available on your profile, it will appear here automatically.</span></div>";
      grid.append(empty);
      return;
    }

    let movableIndex = 0;
    for (const badge of badges) {
      const index = badge.movable ? movableIndex++ : -1;
      grid.append(createBadgeCard(badge, index, movable.length));
    }
  }

  function renderPreview() {
    if (!preview) return;
    preview.replaceChildren();
    for (const badge of displayedBadges()) {
      const item = document.createElement("span");
      item.className = "preview-badge";
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

  render();
})();
