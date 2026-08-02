(() => {
  const appearance = document.getElementById("appearance");
  if (!appearance) return;

  const section = document.createElement("section");
  section.className = "client-auth-panel";
  section.innerHTML = `
    <div class="client-auth-copy">
      <div class="client-auth-heading">
        <div>
          <strong>Plugin authorization token</strong>
          <span>Required for Vencord, Revenge, and Kettu to securely report your profile badges.</span>
        </div>
        <span class="client-auth-status" data-token-status>Checking…</span>
      </div>
      <p class="client-auth-note">Generate a token, copy it once, then paste it into the Jadges plugin settings. Creating another token immediately revokes the previous one.</p>
      <div class="client-auth-token-wrap" hidden data-token-wrap>
        <code data-token-value></code>
        <button type="button" class="client-auth-copy-button" data-copy-token>Copy</button>
      </div>
      <div class="client-auth-expiry" data-token-expiry></div>
    </div>
    <div class="client-auth-actions">
      <button type="button" class="secondary-button client-auth-generate" data-generate-token>Generate token</button>
      <button type="button" class="client-auth-revoke" data-revoke-token hidden>Revoke</button>
    </div>`;

  appearance.insertAdjacentElement("afterend", section);

  const status = section.querySelector("[data-token-status]");
  const expiry = section.querySelector("[data-token-expiry]");
  const tokenWrap = section.querySelector("[data-token-wrap]");
  const tokenValue = section.querySelector("[data-token-value]");
  const generateButton = section.querySelector("[data-generate-token]");
  const revokeButton = section.querySelector("[data-revoke-token]");
  const copyButton = section.querySelector("[data-copy-token]");

  function setBusy(busy) {
    if (generateButton) generateButton.disabled = busy;
    if (revokeButton) revokeButton.disabled = busy;
  }

  function formatExpiry(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "";
    return `Expires ${new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date)}`;
  }

  function renderState(data) {
    const configured = data?.configured === true;
    if (status) {
      status.textContent = configured ? "Active" : "Not configured";
      status.classList.toggle("active", configured);
    }
    if (expiry) expiry.textContent = configured ? formatExpiry(data.expiresAt) : "";
    if (generateButton) generateButton.textContent = configured ? "Rotate token" : "Generate token";
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
    if (!response.ok) throw new Error(body.error || "Could not manage the plugin token");
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

  generateButton?.addEventListener("click", async () => {
    const rotating = status?.classList.contains("active");
    if (rotating && !window.confirm("Rotate your plugin token? The old token will stop working immediately.")) {
      return;
    }

    setBusy(true);
    try {
      const body = await request("POST");
      if (!body) return;
      renderState(body);
      if (tokenValue) tokenValue.textContent = body.token || "";
      if (tokenWrap) tokenWrap.hidden = !body.token;
      copyButton?.focus();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not generate the token");
    } finally {
      setBusy(false);
    }
  });

  revokeButton?.addEventListener("click", async () => {
    if (!window.confirm("Revoke your plugin token? Badge reporting will stop until you generate and configure a new token.")) {
      return;
    }

    setBusy(true);
    try {
      const body = await request("DELETE");
      if (!body) return;
      renderState(body);
      if (tokenValue) tokenValue.textContent = "";
      if (tokenWrap) tokenWrap.hidden = true;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not revoke the token");
    } finally {
      setBusy(false);
    }
  });

  copyButton?.addEventListener("click", async () => {
    const token = tokenValue?.textContent || "";
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      copyButton.textContent = "Copied";
      setTimeout(() => {
        copyButton.textContent = "Copy";
      }, 1600);
    } catch {
      window.prompt("Copy your Jadges plugin token:", token);
    }
  });

  void loadStatus();
})();
