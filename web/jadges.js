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
      for (const badge of badges) {
        categoryGrid.append(createBadgeCard(badge, -1, 0, category));
      }
    } else {
      const movableKeys = categoryKeys(category);
      for (const badge of badges) {
        const index = badge.movable ? movableKeys.indexOf(badge.key) : -1;
        categoryGrid.append(
          createBadgeCard(badge, index, movableKeys.length, category),
        );
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
