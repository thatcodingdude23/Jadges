(() => {
  const appearance = document.getElementById("appearance");
  if (!appearance) return;

  const section = document.createElement("section");
  section.className = "client-auth-panel";
  section.innerHTML = `
    <div class="client-auth-copy">
      <div class="client-auth-heading">
        <div>
          <strong>Automatic plugin authorization</strong>
          <span>Vencord, Revenge, and Kettu securely connect themselves to your Discord account.</span>
        </div>
        <span class="client-auth-status" data-token-status>Checking…</span>
      </div>
      <p class="client-auth-note">No token copying is required. When Jadges needs authorization, it opens Discord login once and stores the generated account token inside the client automatically.</p>
      <div class="client-auth-expiry" data-token-expiry></div>
    </div>
    <div class="client-auth-actions">
      <button type="button" class="client-auth-revoke" data-revoke-token hidden>Disconnect clients</button>
    </div>`;

  appearance.insertAdjacentElement("afterend", section);

  const status = section.querySelector("[data-token-status]");
  const expiry = section.querySelector("[data-token-expiry]");
  const revokeButton = section.querySelector("[data-revoke-token]");

  function setBusy(busy) {
    if (revokeButton) revokeButton.disabled = busy;
  }

  function formatExpiry(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "";
    return `Authorization refreshes automatically • Current token expires ${new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date)}`;
  }

  function renderState(data) {
    const configured = data?.configured === true;
    if (status) {
      status.textContent = configured ? "Connected" : "Automatic";
      status.classList.toggle("active", configured);
    }
    if (expiry) {
      expiry.textContent = configured
        ? formatExpiry(data.expiresAt)
        : "Enable Jadges in a supported client and it will connect automatically.";
    }
    if (revokeButton) revokeButton.hidden = !configured;
  }

  async function request(method) {
    const response = await fetch("/api/client-token", {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) {
      window.location.assign("/login");
      return undefined;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not manage plugin authorization");
    return body;
  }

  async function loadStatus() {
    try {
      const body = await request("GET");
      if (body) renderState(body);
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : "Unavailable";
    }
  }

  revokeButton?.addEventListener("click", async () => {
    if (!window.confirm("Disconnect all Jadges clients? They will open authorization again the next time they report profile data.")) {
      return;
    }

    setBusy(true);
    try {
      const body = await request("DELETE");
      if (body) renderState(body);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not disconnect clients");
    } finally {
      setBusy(false);
    }
  });

  void loadStatus();
})();
