(() => {
  const grid = document.getElementById("badge-grid");
  const saveIndicator = document.getElementById("save-indicator");
  if (!grid) return;

  let deleting = false;

  function setSaveState(text, isError = false) {
    if (!saveIndicator) return;
    saveIndicator.classList.toggle("error", isError);
    const label = saveIndicator.querySelector("span:last-child");
    if (label) label.textContent = text;
  }

  function canDelete(key) {
    return key === "nitro" || /^custom:[0-9a-f-]{1,100}$/i.test(key);
  }

  function trashIcon() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7h16"></path>
        <path d="M9 3h6l1 4H8l1-4Z"></path>
        <path d="m7 7 1 13h8l1-13"></path>
        <path d="M10 11v5M14 11v5"></path>
      </svg>`;
  }

  async function deleteBadge(card, button) {
    if (deleting) return;
    const key = card.dataset.key || "";
    if (!canDelete(key)) return;

    const name = card.querySelector(".badge-name")?.textContent?.trim() || "this badge";
    const confirmed = window.confirm(
      `Delete ${name}?\n\nThis permanently removes it from your Jadges account and Discord profile.`,
    );
    if (!confirmed) return;

    deleting = true;
    button.disabled = true;
    card.classList.add("badge-card-deleting");
    setSaveState("Deleting badge…");

    try {
      const response = await fetch("/api/delete-badge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key }),
      });

      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }

      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not delete badge");

      setSaveState("Badge deleted");
      card.classList.add("badge-card-deleted");
      setTimeout(() => window.location.reload(), 180);
    } catch (error) {
      deleting = false;
      button.disabled = false;
      card.classList.remove("badge-card-deleting");
      setSaveState(
        error instanceof Error ? error.message : "Could not delete badge",
        true,
      );
    }
  }

  function patchCards() {
    for (const card of grid.querySelectorAll(".badge-card")) {
      if (!(card instanceof HTMLElement)) continue;
      const key = card.dataset.key || "";
      if (!canDelete(key)) continue;
      if (card.querySelector(".badge-delete-button")) continue;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "badge-delete-button";
      button.title = "Delete badge";
      button.setAttribute("aria-label", `Delete ${card.querySelector(".badge-name")?.textContent || "badge"}`);
      button.innerHTML = trashIcon();
      button.addEventListener("mousedown", (event) => event.stopPropagation());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void deleteBadge(card, button);
      });
      card.append(button);
    }
  }

  const observer = new MutationObserver(patchCards);
  observer.observe(grid, { childList: true, subtree: true });
  patchCards();
})();
