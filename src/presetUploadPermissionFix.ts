export const presetUploadPermissionFixScript = String.raw`
(() => {
  const input = document.getElementById("preset-file");
  const form = document.getElementById("preset-confirm-form");
  const error = document.getElementById("preset-form-error");
  if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return;

  let stabilization = Promise.resolve(true);
  let stableFile;
  let resubmitting = false;

  function showError(message) {
    if (error) error.textContent = message;
  }

  async function stabilize(file) {
    try {
      const bytes = await file.arrayBuffer();
      const copy = new File([bytes], file.name || "preset-image", {
        type: file.type || "application/octet-stream",
        lastModified: file.lastModified || Date.now()
      });
      const transfer = new DataTransfer();
      transfer.items.add(copy);
      input.files = transfer.files;
      stableFile = copy;
      input.dataset.jadgesStableFile = "true";
      return true;
    } catch (readError) {
      stableFile = undefined;
      delete input.dataset.jadgesStableFile;
      showError(
        "Android stopped Jadges from reading that temporary file. Choose the image again, then confirm the upload without leaving this page."
      );
      console.warn("[Jadges Presets] Could not preserve selected image:", readError);
      return false;
    }
  }

  input.addEventListener("change", event => {
    const selected = event.target instanceof HTMLInputElement
      ? event.target.files?.[0]
      : undefined;
    stableFile = undefined;
    delete input.dataset.jadgesStableFile;
    if (!selected) {
      stabilization = Promise.resolve(false);
      return;
    }
    stabilization = stabilize(selected);
  }, true);

  form.addEventListener("submit", event => {
    if (resubmitting || (stableFile && input.dataset.jadgesStableFile === "true")) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void stabilization.then(ok => {
      if (!ok || !stableFile) return;
      resubmitting = true;
      try {
        form.requestSubmit();
      } finally {
        queueMicrotask(() => {
          resubmitting = false;
        });
      }
    });
  }, true);
})();
`;
