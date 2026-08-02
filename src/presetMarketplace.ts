import type { IncomingMessage, ServerResponse } from "node:http";
import { detailPage, errorPage, presetsPage, uploadPage } from "./presetPages.js";
import { claimPreset, createPreset, findPreset, listPresets, type PresetUploadPayload } from "./presetStore.js";
import {
  discordBotUser,
  handlePresetCallback,
  originAllowed,
  readJson,
  redirect,
  requirePageLogin,
  safeReturnTo,
  sendHtml,
  sendJson,
  servePresetAsset,
  servePresetImage,
  sessionUserId,
  startPresetLogin,
} from "./presetWeb.js";

export async function handlePresetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
): Promise<boolean> {
  if (url.pathname === "/assets/presets.css" || url.pathname === "/assets/presets.js") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    await servePresetAsset(response, url.pathname.endsWith(".css") ? "presets.css" : "presets.js");
    return true;
  }

  const imageMatch = /^\/preset-images\/([^/]+)$/.exec(url.pathname);
  if (imageMatch?.[1]) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    await servePresetImage(
      response,
      decodeURIComponent(imageMatch[1]),
      request.method === "HEAD",
    );
    return true;
  }

  if (url.pathname === "/oauth/callback") {
    return handlePresetCallback(request, response, url);
  }

  if (url.pathname === "/presets/login") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const next = safeReturnTo(url.searchParams.get("next"));
    if (sessionUserId(request)) {
      redirect(response, next);
      return true;
    }
    await startPresetLogin(response, next);
    return true;
  }

  if (url.pathname === "/presets") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const userId = requirePageLogin(request, response, `${url.pathname}${url.search}`);
    if (!userId) return true;
    const [profile, presets] = await Promise.all([
      discordBotUser(userId),
      listPresets(),
    ]);
    sendHtml(response, 200, presetsPage(profile, presets, url.searchParams.get("uploaded") === "1"));
    return true;
  }

  if (url.pathname === "/presets/upload") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const userId = requirePageLogin(request, response, url.pathname);
    if (!userId) return true;
    sendHtml(response, 200, uploadPage(await discordBotUser(userId)));
    return true;
  }

  const detailMatch = /^\/presets\/([a-f0-9-]+)$/.exec(url.pathname);
  if (detailMatch?.[1]) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const userId = requirePageLogin(request, response, url.pathname);
    if (!userId) return true;
    const [profile, preset] = await Promise.all([
      discordBotUser(userId),
      findPreset(detailMatch[1]),
    ]);
    if (!preset) {
      sendHtml(response, 404, errorPage(profile, "Preset not found", "This preset may have been removed."));
      return true;
    }
    sendHtml(response, 200, detailPage(profile, preset));
    return true;
  }

  if (url.pathname === "/api/presets/upload") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const userId = sessionUserId(request);
    if (!userId) {
      sendJson(response, 401, { error: "Login required" });
      return true;
    }
    if (!originAllowed(request, origin)) {
      sendJson(response, 403, { error: "Origin check failed" });
      return true;
    }

    const rawContentType = request.headers["content-type"];
    const contentType = (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType)
      ?.split(";")[0]?.trim();
    if (contentType !== "application/json") {
      sendJson(response, 415, { error: "Content type must be application/json" });
      return true;
    }

    try {
      const profile = await discordBotUser(userId);
      const username = profile.username?.trim() || "discord-user";
      const displayName = profile.global_name?.trim() || username;
      const preset = await createPreset(
        userId,
        { id: userId, username, displayName },
        await readJson(request) as PresetUploadPayload,
      );
      sendJson(response, 201, { preset: { id: preset.id, name: preset.name } });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Upload failed",
      });
    }
    return true;
  }

  const claimMatch = /^\/api\/presets\/([a-f0-9-]+)\/claim$/.exec(url.pathname);
  if (claimMatch?.[1]) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return true;
    }
    const userId = sessionUserId(request);
    if (!userId) {
      sendJson(response, 401, { error: "Login required" });
      return true;
    }
    if (!originAllowed(request, origin)) {
      sendJson(response, 403, { error: "Origin check failed" });
      return true;
    }

    try {
      const preset = await findPreset(claimMatch[1]);
      if (!preset) {
        sendJson(response, 404, { error: "Preset not found" });
        return true;
      }
      const added = await claimPreset(userId, preset);
      sendJson(response, 200, {
        added,
        message: added
          ? "Badge added to your profile."
          : "This badge is already on your profile.",
      });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Could not add badge",
      });
    }
    return true;
  }

  return false;
}
