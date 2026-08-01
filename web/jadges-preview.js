(() => {
  const SERVER_ICON = "https://cdn.discordapp.com/icons/1531693275914834040/9542e90ac0bb7dd30cb9425f9487462e.webp?size=1024";
  const PREVIEW_MESSAGES = [
    {
      name: "jayden",
      avatar: "https://cdn.discordapp.com/avatars/1439230248100036798/a_13be5434bfdfc33c8a46a4dd19a77627.gif?size=1024&animated=true",
      message: "YO! I can change my discord theme for FREE!",
    },
    {
      name: "eron",
      avatar: "https://cdn.discordapp.com/avatars/1386341063995822220/a_2234e3df3f9c5da0e19514b248eada8a.webp?size=160&animated=true",
      message: "No way! That's so cool. I should try it!",
    },
  ];

  function createImage(src, alt, className) {
    const image = document.createElement("img");
    image.src = src;
    image.alt = alt;
    image.className = className;
    image.referrerPolicy = "no-referrer";
    image.style.width = "100%";
    image.style.height = "100%";
    image.style.display = "block";
    image.style.objectFit = "cover";
    return image;
  }

  function createMessage({ name, avatar, message }) {
    const row = document.createElement("div");
    row.className = "theme-preview-message";

    const avatarImage = createImage(avatar, `${name}'s avatar`, "theme-preview-avatar");
    avatarImage.style.borderRadius = "50%";

    const content = document.createElement("div");
    const sender = document.createElement("strong");
    sender.textContent = name;
    const text = document.createElement("p");
    text.textContent = message;
    content.append(sender, text);

    row.append(avatarImage, content);
    return row;
  }

  function patchPreview() {
    const preview = document.getElementById("theme-discord-preview");
    if (!preview) return false;

    const server = preview.querySelector(".theme-preview-server:not(.muted)");
    if (server && server.dataset.jadgesPreviewIcon !== "ready") {
      server.dataset.jadgesPreviewIcon = "ready";
      server.textContent = "";
      server.style.overflow = "hidden";
      server.style.background = "transparent";
      const icon = createImage(SERVER_ICON, "Jaycord server icon", "theme-preview-server-image");
      icon.style.borderRadius = "inherit";
      server.append(icon);
    }

    const messages = preview.querySelector(".theme-preview-messages");
    if (messages && messages.dataset.jadgesPreviewMessages !== "ready") {
      messages.dataset.jadgesPreviewMessages = "ready";
      messages.replaceChildren(...PREVIEW_MESSAGES.map(createMessage));
    }

    return Boolean(server && messages);
  }

  if (patchPreview()) return;

  const observer = new MutationObserver(() => {
    if (patchPreview()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
