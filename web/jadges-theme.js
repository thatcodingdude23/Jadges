(() => {
  const dataElement = document.getElementById("jadges-data");
  const appearanceLink = document.querySelector('.nav-link[href="#appearance"]');
  if (!dataElement || !appearanceLink) return;

  const DEFAULT_THEME = {
    enabled: false,
    mode: "dark",
    colors: ["#15059E", "#283CA8", "#0367FF"],
    angle: 45,
    intensity: 71,
  };

  let theme = { ...DEFAULT_THEME, colors: [...DEFAULT_THEME.colors] };
  let selectedColor = 0;
  let overlay;
  let status;
  let preview;
  let colorPicker;
  let hexInput;
  let directionInput;
  let intensityInput;
  let directionValue;
  let intensityValue;
  let gradientBar;
  let colorStops;
  let removeColorButton;
  let addColorButton;
  let applyButton;

  const normalizeHex = (value) => {
    const raw = String(value || "").trim().toUpperCase();
    const expanded = /^#[0-9A-F]{3}$/.test(raw)
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw;
    return /^#[0-9A-F]{6}$/.test(expanded) ? expanded : null;
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

  function normalizedTheme(value) {
    const source = value && typeof value === "object" ? value : {};
    const colors = Array.isArray(source.colors)
      ? source.colors.map(normalizeHex).filter(Boolean).slice(0, 5)
      : [];
    return {
      enabled: source.enabled === true,
      mode: source.mode === "light" ? "light" : "dark",
      colors: colors.length ? colors : [...DEFAULT_THEME.colors],
      angle: Math.round(clamp(source.angle ?? DEFAULT_THEME.angle, 0, 360)),
      intensity: Math.round(clamp(source.intensity ?? DEFAULT_THEME.intensity, 0, 100)),
    };
  }

  function setStatus(text, kind = "") {
    if (!status) return;
    status.textContent = text;
    status.className = `theme-editor-status${kind ? ` ${kind}` : ""}`;
  }

  function modeIcon(mode) {
    if (mode === "light") {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V2a1 1 0 0 1 1-1Zm0 6a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm10 4a1 1 0 1 1 0 2h-2a1 1 0 1 1 0-2h2ZM5 11a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2h2Zm13.8-6.8a1 1 0 0 1 0 1.4L17.4 7a1 1 0 1 1-1.4-1.4l1.4-1.4a1 1 0 0 1 1.4 0ZM8 16.9a1 1 0 0 1 0 1.4l-1.4 1.4a1 1 0 0 1-1.4-1.4l1.4-1.4a1 1 0 0 1 1.4 0Zm9.4 0 1.4 1.4a1 1 0 1 1-1.4 1.4L16 18.3a1 1 0 1 1 1.4-1.4ZM6.6 4.2 8 5.6A1 1 0 1 1 6.6 7L5.2 5.6a1 1 0 0 1 1.4-1.4ZM13 20v2a1 1 0 1 1-2 0v-2a1 1 0 1 1 2 0Z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 18.9c.4-.5 0-1.2-.6-1.2A10 10 0 0 1 10.7 4c.3-.8-.4-1.6-1.2-1.3A10 10 0 1 0 20.6 19Z"/><path d="m17.1 8.6-.6-1.7a.5.5 0 0 0-.9 0L15 8.6l-1.7.6a.5.5 0 0 0 0 .9l1.7.6.6 1.7a.5.5 0 0 0 .9 0l.6-1.7 1.7-.6a.5.5 0 0 0 0-.9l-1.7-.6Z"/></svg>';
  }

  function createEditor() {
    overlay = document.createElement("div");
    overlay.className = "theme-editor-backdrop";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <section class="theme-editor" role="dialog" aria-modal="true" aria-labelledby="theme-editor-title">
        <div class="theme-editor-controls">
          <header class="theme-editor-header">
            <h2 id="theme-editor-title">Customize your theme</h2>
            <button class="theme-editor-close" type="button" aria-label="Close">✕</button>
          </header>

          <div class="theme-editor-section">
            <div class="theme-section-label">Appearance</div>
            <div class="theme-mode-pills" role="group" aria-label="Discord appearance">
              <button type="button" data-theme-mode="dark">${modeIcon("dark")}Dark Mode</button>
              <button type="button" data-theme-mode="light">${modeIcon("light")}Light Mode</button>
            </div>
          </div>

          <div class="theme-editor-section">
            <div class="theme-section-label">Colors</div>
            <div class="theme-gradient-bar" id="theme-gradient-bar"><div class="theme-color-stops" id="theme-color-stops"></div></div>
            <div class="theme-picker-row">
              <input class="theme-native-picker" id="theme-native-picker" type="color" aria-label="Choose selected color">
              <label class="theme-hex-wrap">
                <span class="theme-hex-preview" id="theme-hex-preview"></span>
                <input class="theme-hex-input" id="theme-hex-input" maxlength="7" spellcheck="false" inputmode="text" aria-label="Hex color">
              </label>
              <button class="theme-icon-button" id="theme-remove-color" type="button" aria-label="Remove selected color">−</button>
            </div>
            <button class="theme-add-color" id="theme-add-color" type="button">＋ Add Color</button>
          </div>

          <div class="theme-editor-section">
            <div class="theme-section-label">Controls</div>
            <div class="theme-control">
              <div class="theme-control-head"><label for="theme-direction">Gradient Direction</label><output class="theme-control-value" id="theme-direction-value">45°</output></div>
              <input class="theme-range" id="theme-direction" type="range" min="0" max="360" step="1" value="45">
            </div>
            <div class="theme-control">
              <div class="theme-control-head"><label for="theme-intensity">Color Intensity</label><output class="theme-control-value" id="theme-intensity-value">71%</output></div>
              <input class="theme-range" id="theme-intensity" type="range" min="0" max="100" step="1" value="71">
            </div>
          </div>

          <div class="theme-editor-section">
            <div class="theme-editor-status" id="theme-editor-status" aria-live="polite"></div>
          </div>

          <footer class="theme-editor-actions">
            <button class="theme-action" id="theme-surprise" type="button">Surprise Me!</button>
            <button class="theme-action" id="theme-reset" type="button">Reset</button>
            <button class="theme-action primary" id="theme-apply" type="button">Apply</button>
          </footer>
        </div>

        <aside class="theme-editor-preview">
          <div class="theme-preview-heading"><h3>Discord preview</h3><p>Your selected theme is saved to Jadges and applied by the plugin on your Discord app.</p></div>
          <div class="theme-discord-preview" id="theme-discord-preview">
            <div class="theme-preview-servers">
              <div class="theme-preview-server">J</div>
              <div class="theme-preview-server muted">＋</div>
              <div class="theme-preview-server muted">⌁</div>
            </div>
            <div class="theme-preview-channels">
              <div class="theme-preview-workspace">Jaycord</div>
              <div class="theme-preview-category">Information</div>
              <div class="theme-preview-channel active"># general</div>
              <div class="theme-preview-channel"># announcements</div>
              <div class="theme-preview-category">Community</div>
              <div class="theme-preview-channel"># showcase</div>
              <div class="theme-preview-channel"># support</div>
            </div>
            <div class="theme-preview-chat">
              <div class="theme-preview-chat-head"># general</div>
              <div class="theme-preview-messages">
                <div class="theme-preview-message"><div class="theme-preview-avatar"></div><div><strong>Jadges</strong><p>Your Discord theme is now connected to your Jadges account.</p></div></div>
                <div class="theme-preview-message"><div class="theme-preview-avatar"></div><div><strong>Jay</strong><p>Change the colors here and press Apply to sync them.</p></div></div>
              </div>
              <div class="theme-preview-input">Message #general</div>
            </div>
          </div>
          <div class="theme-sync-note">Vencord and Revenge check your Jadges theme every five seconds. A mobile app reload may occur when Revenge applies a newly saved theme.</div>
        </aside>
      </section>`;

    document.body.append(overlay);
    status = overlay.querySelector("#theme-editor-status");
    preview = overlay.querySelector("#theme-discord-preview");
    colorPicker = overlay.querySelector("#theme-native-picker");
    hexInput = overlay.querySelector("#theme-hex-input");
    directionInput = overlay.querySelector("#theme-direction");
    intensityInput = overlay.querySelector("#theme-intensity");
    directionValue = overlay.querySelector("#theme-direction-value");
    intensityValue = overlay.querySelector("#theme-intensity-value");
    gradientBar = overlay.querySelector("#theme-gradient-bar");
    colorStops = overlay.querySelector("#theme-color-stops");
    removeColorButton = overlay.querySelector("#theme-remove-color");
    addColorButton = overlay.querySelector("#theme-add-color");
    applyButton = overlay.querySelector("#theme-apply");

    overlay.querySelector(".theme-editor-close").addEventListener("click", closeEditor);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) closeEditor();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && overlay.classList.contains("open")) closeEditor();
    });

    overlay.querySelectorAll("[data-theme-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        theme.mode = button.dataset.themeMode === "light" ? "light" : "dark";
        render();
      });
    });

    colorPicker.addEventListener("input", () => updateSelectedColor(colorPicker.value));
    hexInput.addEventListener("input", () => {
      const value = normalizeHex(hexInput.value);
      hexInput.setAttribute("aria-invalid", String(!value));
      if (value) updateSelectedColor(value, false);
    });
    hexInput.addEventListener("blur", () => render());

    removeColorButton.addEventListener("click", () => {
      if (theme.colors.length <= 1) return;
      theme.colors.splice(selectedColor, 1);
      selectedColor = Math.min(selectedColor, theme.colors.length - 1);
      render();
    });

    addColorButton.addEventListener("click", () => {
      if (theme.colors.length >= 5) return;
      const source = theme.colors[selectedColor] || "#5865F2";
      theme.colors.splice(selectedColor + 1, 0, source);
      selectedColor += 1;
      render();
    });

    directionInput.addEventListener("input", () => {
      theme.angle = Math.round(clamp(directionInput.value, 0, 360));
      renderPreview();
      directionValue.textContent = `${theme.angle}°`;
    });
    intensityInput.addEventListener("input", () => {
      theme.intensity = Math.round(clamp(intensityInput.value, 0, 100));
      renderPreview();
      intensityValue.textContent = `${theme.intensity}%`;
    });

    overlay.querySelector("#theme-surprise").addEventListener("click", () => {
      const count = 2 + Math.floor(Math.random() * 3);
      theme.colors = Array.from({ length: count }, () => `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`);
      theme.angle = Math.floor(Math.random() * 361);
      theme.intensity = 45 + Math.floor(Math.random() * 51);
      selectedColor = 0;
      setStatus("A new combination is ready. Press Apply to save it.");
      render();
    });

    overlay.querySelector("#theme-reset").addEventListener("click", () => {
      theme = { ...DEFAULT_THEME, colors: [...DEFAULT_THEME.colors] };
      selectedColor = 0;
      setStatus("Reset to the Jadges defaults. Press Apply to use them.");
      render();
    });

    applyButton.addEventListener("click", saveTheme);
    render();
  }

  function updateSelectedColor(value, updateInput = true) {
    const normalized = normalizeHex(value);
    if (!normalized) return;
    theme.colors[selectedColor] = normalized;
    if (updateInput) hexInput.value = normalized;
    render();
  }

  function gradient(alpha = 1) {
    const colors = theme.colors.map((color, index) => {
      const position = theme.colors.length === 1 ? 50 : Math.round(index * 100 / (theme.colors.length - 1));
      if (alpha >= 1) return `${color} ${position}%`;
      const hex = color.slice(1);
      const red = parseInt(hex.slice(0, 2), 16);
      const green = parseInt(hex.slice(2, 4), 16);
      const blue = parseInt(hex.slice(4, 6), 16);
      return `rgba(${red}, ${green}, ${blue}, ${alpha}) ${position}%`;
    });
    return `linear-gradient(${theme.angle}deg, ${colors.join(", ")})`;
  }

  function renderPreview() {
    if (!preview) return;
    const light = theme.mode === "light";
    const intensity = theme.intensity / 100;
    const accent = theme.colors[0] || "#5865F2";
    preview.style.setProperty("--theme-preview-primary", light ? "#F6F7F9" : "#111318");
    preview.style.setProperty("--theme-preview-secondary", light ? "#E8EAF0" : "#1A1D25");
    preview.style.setProperty("--theme-preview-tertiary", light ? "#D9DCE4" : "#090B10");
    preview.style.setProperty("--theme-preview-text", light ? "#17191F" : "#F3F5F8");
    preview.style.setProperty("--theme-preview-muted", light ? "#5C6370" : "#A7AEBA");
    preview.style.setProperty("--theme-preview-accent", accent);
    preview.style.setProperty("--theme-preview-gradient", gradient(Math.max(0.05, intensity * 0.42)));
  }

  function render() {
    if (!overlay) return;
    selectedColor = Math.max(0, Math.min(selectedColor, theme.colors.length - 1));
    overlay.querySelectorAll("[data-theme-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeMode === theme.mode));
    });

    gradientBar.style.background = gradient();
    colorStops.replaceChildren();
    theme.colors.forEach((color, index) => {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = `theme-color-stop${index === selectedColor ? " selected" : ""}`;
      stop.style.left = `${theme.colors.length === 1 ? 50 : index * 100 / (theme.colors.length - 1)}%`;
      stop.style.backgroundColor = color;
      stop.setAttribute("aria-label", `Edit color ${index + 1}: ${color}`);
      stop.addEventListener("click", () => {
        selectedColor = index;
        render();
      });
      colorStops.append(stop);
    });

    const selected = theme.colors[selectedColor] || "#5865F2";
    colorPicker.value = selected;
    hexInput.value = selected;
    hexInput.setAttribute("aria-invalid", "false");
    overlay.querySelector("#theme-hex-preview").style.backgroundColor = selected;
    removeColorButton.disabled = theme.colors.length <= 1;
    addColorButton.disabled = theme.colors.length >= 5;
    directionInput.value = String(theme.angle);
    intensityInput.value = String(theme.intensity);
    directionValue.textContent = `${theme.angle}°`;
    intensityValue.textContent = `${theme.intensity}%`;
    renderPreview();
  }

  async function loadTheme() {
    setStatus("Loading your saved theme…");
    try {
      const response = await fetch("/api/theme", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load your theme");
      theme = normalizedTheme(body.theme);
      selectedColor = 0;
      setStatus(theme.enabled ? "Your saved Discord theme is active." : "Choose your colors and press Apply.");
      render();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load your theme", "error");
    }
  }

  async function saveTheme() {
    applyButton.disabled = true;
    setStatus("Saving and syncing your Discord theme…");
    try {
      const response = await fetch("/api/theme", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ...theme, enabled: true }),
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not save your theme");
      theme = normalizedTheme(body.theme);
      setStatus("Applied. Jadges will update your Discord app within five seconds.", "success");
      render();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save your theme", "error");
    } finally {
      applyButton.disabled = false;
    }
  }

  function openEditor() {
    if (!overlay) createEditor();
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    void loadTheme();
    setTimeout(() => overlay.querySelector(".theme-editor-close")?.focus(), 0);
  }

  function closeEditor() {
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  appearanceLink.addEventListener("click", (event) => {
    event.preventDefault();
    openEditor();
  });
})();
