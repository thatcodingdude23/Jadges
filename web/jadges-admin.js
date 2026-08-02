(() => {
  "use strict";

  const csrf = document.querySelector('meta[name="jadges-admin-csrf"]')?.content || "";
  const state = {
    selectedUserId: "",
    selectedUser: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function toast(message, error = false) {
    const stack = $("#toast-stack");
    if (!stack) return;
    const item = document.createElement("div");
    item.className = `toast${error ? " error" : ""}`;
    item.textContent = message;
    stack.append(item);
    setTimeout(() => item.remove(), 4500);
  }

  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      headers.set("x-jadges-csrf", csrf);
    }

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed with HTTP ${response.status}`);
    }
    return body;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function showView(name) {
    $$(".admin-nav").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === name);
    });
    $$(".admin-view").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panel === name);
    });
    if (name === "overview") void loadStats();
    if (name === "audit") void loadAudit();
  }

  $$(".admin-nav").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });

  async function loadStats() {
    const grid = $("#stats-grid");
    if (!grid) return;
    grid.innerHTML = '<div class="loading-card">Loading statistics…</div>';

    try {
      const data = await api("/api/admin/stats");
      const cards = [
        ["Stored users", formatNumber(data.storedUsers), `${formatNumber(data.blockedUsers)} blocked`],
        ["Approved badges", formatNumber(data.approvedBadges), `${formatNumber(data.pendingBadges)} pending`],
        ["Nitro profiles", formatNumber(data.equippedNitro), `${formatNumber(data.pendingNitro)} pending`],
        ["Native badges", formatNumber(data.nativeBadges), "Observed by Jadges"],
        ["Stored images", formatNumber(data.imageFiles), formatBytes(data.imageBytes)],
        ["Server members", formatNumber(data.guildMembers), `${formatNumber(data.guildOnline)} online`],
      ];

      grid.innerHTML = cards.map(([label, value, note]) => `
        <article class="stat-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </article>
      `).join("");
    } catch (error) {
      grid.innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  function flags(user) {
    const values = [];
    values.push(`<span class="tag ${user.inGuild ? "green" : ""}">${user.inGuild ? "In server" : "Not in server"}</span>`);
    if (user.blocked) values.push('<span class="tag red">Blocked</span>');
    if (user.stored) values.push('<span class="tag">Stored</span>');
    return values.join("");
  }

  function renderResults(target, users, compact = false) {
    const container = $(target);
    if (!container) return;

    if (!Array.isArray(users) || users.length === 0) {
      container.innerHTML = '<div class="empty-state"><strong>No users found</strong><p>Try a Discord user ID or another username.</p></div>';
      return;
    }

    container.innerHTML = users.map((user) => `
      <button class="user-result${state.selectedUserId === user.id ? " active" : ""}" data-user-id="${escapeHtml(user.id)}">
        <img src="${escapeHtml(user.avatar)}" alt="">
        <span>
          <strong>${escapeHtml(user.displayName)}</strong>
          <span>@${escapeHtml(user.username)} • ${escapeHtml(user.id)}</span>
        </span>
        <span class="user-flags">
          <span class="tag ${user.inGuild ? "green" : ""}">${user.inGuild ? "Server" : "Outside"}</span>
          ${user.blocked ? '<span class="tag red">Blocked</span>' : ""}
          ${!compact ? `<span class="tag">${formatNumber(user.badgeCount)} badges</span>` : ""}
        </span>
      </button>
    `).join("");

    $$(".user-result", container).forEach((button) => {
      button.addEventListener("click", () => {
        const userId = button.dataset.userId;
        if (userId) void selectUser(userId);
      });
    });
  }

  async function runSearch(query, target, compact = false) {
    const normalized = query.trim();
    if (!normalized) {
      toast("Enter a user ID or username.", true);
      return;
    }

    const container = $(target);
    if (container) container.innerHTML = '<div class="loading-card">Searching Discord…</div>';

    try {
      const data = await api(`/api/admin/users?q=${encodeURIComponent(normalized)}`);
      renderResults(target, data.users, compact);
      const count = $("#result-count");
      if (count && target === "#user-results") {
        count.textContent = `${data.users.length} user${data.users.length === 1 ? "" : "s"}`;
      }
    } catch (error) {
      if (container) container.innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  $("#overview-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void runSearch($("#overview-search")?.value || "", "#overview-results", true);
  });

  $("#user-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void runSearch($("#user-search")?.value || "", "#user-results");
  });

  async function confirmAction(title, copy, dangerLabel = "Confirm") {
    const dialog = $("#confirm-dialog");
    const titleNode = $("#confirm-title");
    const copyNode = $("#confirm-copy");
    const reasonInput = $("#confirm-reason");
    const submit = $("#confirm-submit");
    if (!dialog || !titleNode || !copyNode || !reasonInput || !submit) {
      return null;
    }

    titleNode.textContent = title;
    copyNode.textContent = copy;
    reasonInput.value = "";
    submit.textContent = dangerLabel;

    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener("close", onClose);
        const reason = reasonInput.value.trim();
        resolve(dialog.returnValue === "confirm" && reason.length >= 3 ? reason : null);
      };
      dialog.addEventListener("close", onClose);
      dialog.showModal();
      setTimeout(() => reasonInput.focus(), 50);
    });
  }

  function badgeRows(user) {
    const badges = Array.isArray(user.badges) ? user.badges : [];
    if (badges.length === 0) {
      return '<div class="empty-state"><strong>No custom badges</strong><p>This user has no stored custom badge requests.</p></div>';
    }

    return badges.map((badge) => `
      <div class="badge-row">
        <img src="${escapeHtml(badge.image)}" alt="">
        <div>
          <strong>${escapeHtml(badge.name)}</strong>
          <span>${badge.pending ? "Pending review" : "Approved"} • ${escapeHtml(formatDate(badge.approvedAt || badge.createdAt))}</span>
        </div>
        <button class="button danger remove-badge" data-badge-id="${escapeHtml(badge.id)}" data-badge-name="${escapeHtml(badge.name)}">Remove</button>
      </div>
    `).join("");
  }

  function renderUserDetail(user) {
    const panel = $("#user-detail");
    if (!panel) return;

    panel.innerHTML = `
      <div class="user-header">
        <img src="${escapeHtml(user.avatar)}" alt="">
        <div>
          <h3>${escapeHtml(user.displayName)}</h3>
          <p>@${escapeHtml(user.username)} • ${escapeHtml(user.id)}</p>
        </div>
        <div class="user-flags">${flags(user)}</div>
      </div>
      <div class="detail-body">
        <div class="detail-grid">
          <div class="detail-item"><span>Discord server</span><strong>${user.inGuild ? "Member" : "Not a member"}</strong></div>
          <div class="detail-item"><span>Jadges record</span><strong>${user.stored ? "Stored" : "None"}</strong></div>
          <div class="detail-item"><span>Submission access</span><strong>${user.blocked ? "Blocked" : "Allowed"}</strong></div>
          <div class="detail-item"><span>Joined</span><strong>${escapeHtml(formatDate(user.joinedAt))}</strong></div>
          <div class="detail-item"><span>Badge side</span><strong>${escapeHtml(user.badgeSide || "Default")}</strong></div>
          <div class="detail-item"><span>Roles detected</span><strong>${formatNumber(user.roles?.length || 0)}</strong></div>
        </div>

        <section class="subsection">
          <h4>Custom badges</h4>
          <div class="badge-list">${badgeRows(user)}</div>
        </section>

        <section class="subsection">
          <h4>Jadges controls</h4>
          <div class="action-grid">
            <button class="button ${user.blocked ? "ghost" : "warning"}" id="toggle-block">${user.blocked ? "Unblock submissions" : "Block submissions"}</button>
            <button class="button danger" id="remove-all" ${user.stored ? "" : "disabled"}>Remove all badges</button>
            <button class="button danger" id="purge-user" ${user.stored ? "" : "disabled"}>Purge Jadges record</button>
            <button class="button ghost" id="refresh-user">Refresh user</button>
          </div>
        </section>

        <section class="subsection">
          <h4>Discord server controls</h4>
          <div class="action-grid">
            <button class="button warning" data-server-action="kick" ${user.inGuild ? "" : "disabled"}>Kick from server</button>
            <button class="button danger" data-server-action="ban">Ban user</button>
            <button class="button ghost" data-server-action="unban">Unban user</button>
          </div>
        </section>
      </div>
    `;

    $$(".remove-badge", panel).forEach((button) => {
      button.addEventListener("click", async () => {
        const badgeId = button.dataset.badgeId;
        const badgeName = button.dataset.badgeName || "badge";
        if (!badgeId) return;
        const reason = await confirmAction(
          "Remove badge",
          `Remove “${badgeName}” from ${user.displayName}?`,
          "Remove badge",
        );
        if (!reason) {
          toast("A reason of at least 3 characters is required.", true);
          return;
        }
        await postUserOperation(user.id, "remove-badge", { badgeId, reason });
      });
    });

    $("#toggle-block", panel)?.addEventListener("click", async () => {
      const next = !user.blocked;
      const reason = await confirmAction(
        next ? "Block badge submissions" : "Unblock badge submissions",
        `${next ? "Block" : "Restore"} badge submission access for ${user.displayName}?`,
        next ? "Block user" : "Unblock user",
      );
      if (!reason) {
        toast("A reason of at least 3 characters is required.", true);
        return;
      }
      await postUserOperation(user.id, "block", { blocked: next, reason });
    });

    $("#remove-all", panel)?.addEventListener("click", async () => {
      const reason = await confirmAction(
        "Remove every badge",
        `Delete all custom, Nitro, pending, and observed badge data for ${user.displayName}? Their blocked state and base user record will remain.`,
        "Remove all badges",
      );
      if (!reason) {
        toast("A reason of at least 3 characters is required.", true);
        return;
      }
      await postUserOperation(user.id, "remove-all", { reason });
    });

    $("#purge-user", panel)?.addEventListener("click", async () => {
      const reason = await confirmAction(
        "Purge Jadges user",
        `Permanently delete the complete Jadges record and uploaded badge images for ${user.displayName}?`,
        "Purge user",
      );
      if (!reason) {
        toast("A reason of at least 3 characters is required.", true);
        return;
      }
      await postUserOperation(user.id, "purge", { reason });
    });

    $("#refresh-user", panel)?.addEventListener("click", () => void selectUser(user.id));

    $$('[data-server-action]', panel).forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.serverAction;
        if (!["kick", "ban", "unban"].includes(action)) return;
        const reason = await confirmAction(
          `${action[0].toUpperCase()}${action.slice(1)} Discord user`,
          `${action} ${user.displayName} (${user.id}) through the Jadges bot? Discord permissions and role hierarchy still apply.`,
          `${action[0].toUpperCase()}${action.slice(1)}`,
        );
        if (!reason) {
          toast("A reason of at least 3 characters is required.", true);
          return;
        }
        await postUserOperation(user.id, "server", { action, reason });
      });
    });
  }

  async function selectUser(userId) {
    state.selectedUserId = userId;
    const panel = $("#user-detail");
    if (panel) panel.innerHTML = '<div class="loading-card">Loading user data…</div>';

    try {
      const user = await api(`/api/admin/users/${encodeURIComponent(userId)}`);
      state.selectedUser = user;
      renderUserDetail(user);
      $$(".user-result").forEach((button) => {
        button.classList.toggle("active", button.dataset.userId === userId);
      });
      showView("users");
    } catch (error) {
      if (panel) panel.innerHTML = `<div class="empty-state"><strong>Could not load user</strong><p>${escapeHtml(error.message)}</p></div>`;
      toast(error.message, true);
    }
  }

  async function postUserOperation(userId, operation, body) {
    try {
      const data = await api(`/api/admin/users/${encodeURIComponent(userId)}/${operation}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast(data.action || "Admin action completed.");
      state.selectedUser = data.user;
      renderUserDetail(data.user);
      void loadStats();
      void loadAudit();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function loadAudit() {
    const list = $("#audit-list");
    if (!list) return;
    list.innerHTML = '<div class="loading-card">Loading audit history…</div>';

    try {
      const data = await api("/api/admin/audit");
      if (!Array.isArray(data.events) || data.events.length === 0) {
        list.innerHTML = '<div class="empty-state"><strong>No audit events yet</strong><p>Administrative and denied-access events will appear here.</p></div>';
        return;
      }

      list.innerHTML = data.events.map((event) => `
        <article class="audit-entry">
          <time>${escapeHtml(formatDate(event.at))}</time>
          <div>
            <strong>${escapeHtml(event.action)}</strong>
            <p>
              Actor: @${escapeHtml(event.actorUsername)} (${escapeHtml(event.actorId)})
              ${event.targetId ? ` • Target: @${escapeHtml(event.targetUsername || "unknown")} (${escapeHtml(event.targetId)})` : ""}
              ${event.reason ? ` • Reason: ${escapeHtml(event.reason)}` : ""}
            </p>
          </div>
          <span class="audit-kind ${event.kind === "security" ? "security" : "action"}">${escapeHtml(event.kind)}</span>
        </article>
      `).join("");
    } catch (error) {
      list.innerHTML = `<div class="loading-card">${escapeHtml(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  $("#refresh-stats")?.addEventListener("click", () => void loadStats());
  $("#refresh-audit")?.addEventListener("click", () => void loadAudit());

  void loadStats();
})();
