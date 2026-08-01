from pathlib import Path

path = Path("src/rearrange.ts")
text = path.read_text()


def replace_once(old: str, new: str) -> None:
    global text
    if old not in text:
        raise SystemExit(f"Expected source block was not found:\n{old[:180]}")
    text = text.replace(old, new, 1)


replace_once(
    '''import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";''',
    '''import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { config } from "./config.js";''',
)

replace_once(
    '''const NATIVE_REPORT_COOLDOWN_MS = 1_500;
const nativeReportTimes = new Map<string, number>();''',
    '''const NATIVE_REPORT_COOLDOWN_MS = 1_500;
const REVOKED_TICKETS_FILE = path.join(
  config.dataDir,
  "rearrange-revocations.json",
);
const nativeReportTimes = new Map<string, number>();
const revokedTickets = new Map<string, number>();
let revokedTicketsLoaded = false;
let revocationWrite: Promise<void> = Promise.resolve();''',
)

replace_once(
    '''function parseCookies(request: IncomingMessage): Record<string, string> {''',
    '''function removeExpiredRevocations(): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of revokedTickets) {
    if (expiresAt <= now) revokedTickets.delete(nonce);
  }
}

async function loadRevokedTickets(): Promise<void> {
  if (revokedTicketsLoaded) return;
  revokedTicketsLoaded = true;

  try {
    const parsed = JSON.parse(
      await readFile(REVOKED_TICKETS_FILE, "utf8"),
    ) as { tickets?: unknown };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.tickets ||
      typeof parsed.tickets !== "object" ||
      Array.isArray(parsed.tickets)
    ) {
      return;
    }

    for (const [nonce, rawExpiresAt] of Object.entries(
      parsed.tickets as Record<string, unknown>,
    )) {
      const expiresAt = Number(rawExpiresAt);
      if (/^[a-f0-9]{24}$/.test(nonce) && Number.isFinite(expiresAt)) {
        revokedTickets.set(nonce, expiresAt);
      }
    }
    removeExpiredRevocations();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Could not load terminated rearrangement links:", error);
    }
  }
}

async function persistRevokedTickets(): Promise<void> {
  removeExpiredRevocations();
  const temporaryFile = `${REVOKED_TICKETS_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const tickets = Object.fromEntries(revokedTickets);

  await writeFile(
    temporaryFile,
    `${JSON.stringify({ tickets }, null, 2)}\n`,
    "utf8",
  );
  try {
    await rename(temporaryFile, REVOKED_TICKETS_FILE);
  } catch (error) {
    await unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
}

async function isTicketTerminated(ticket: TicketPayload): Promise<boolean> {
  await loadRevokedTickets();
  const expiresAt = revokedTickets.get(ticket.nonce);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    revokedTickets.delete(ticket.nonce);
    return false;
  }
  return true;
}

async function terminateTicket(ticket: TicketPayload): Promise<boolean> {
  await loadRevokedTickets();
  const existing = revokedTickets.get(ticket.nonce);
  if (existing && existing > Date.now()) return false;

  revokedTickets.set(ticket.nonce, ticket.expiresAt);
  revocationWrite = revocationWrite
    .catch(() => undefined)
    .then(() => persistRevokedTickets());

  try {
    await revocationWrite;
  } catch (error) {
    console.error("Could not persist a terminated rearrangement link:", error);
  }
  return true;
}

function parseCookies(request: IncomingMessage): Record<string, string> {''',
)

replace_once(
    '''function renderRearrangePage(ticket: string, data: RearrangePageData): string {''',
    '''function escapeDiscordMarkdown(value: string): string {
  return value.replace(/([\\`*_~|>])/g, "\\$1");
}

async function discordBotRequest<T>(
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bot ${config.discordToken}`);
  headers.set("user-agent", "Jadges/1.0");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const remote = await fetch(`https://discord.com/api/v10${pathname}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!remote.ok) {
    const details = await remote.text().catch(() => "");
    throw new Error(
      `Discord API returned HTTP ${remote.status}${details ? `: ${details}` : ""}`,
    );
  }
  return await remote.json() as T;
}

async function sendRearrangeLinkTerminatedDm(userId: string): Promise<void> {
  try {
    const profile = await discordBotRequest<{
      username?: string;
      global_name?: string | null;
    }>(`/users/${encodeURIComponent(userId)}`);
    const displayName = escapeDiscordMarkdown(
      profile.global_name?.trim() || profile.username?.trim() || "there",
    );
    const dm = await discordBotRequest<{ id?: string }>(
      "/users/@me/channels",
      {
        method: "POST",
        body: JSON.stringify({ recipient_id: userId }),
      },
    );
    if (!dm.id) throw new Error("Discord did not return a DM channel ID");

    await discordBotRequest<unknown>(
      `/channels/${encodeURIComponent(dm.id)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          embeds: [
            {
              title: "Link Terminated",
              description:
                `Hello, ${displayName}!\n\n` +
                "Our security system detected that someone signed in with a different Discord account and attempted to open your private badge-rearrangement link. To protect your badges, Jadges immediately terminated that link before any changes could be made.\n\n" +
                "You can safely generate a new link using `/badge rearrange`. Please keep rearrangement links private and only open them while signed in to the Discord account that created them.",
              color: 0xed4245,
              footer: {
                text: "Jadges • Security Alert",
              },
              timestamp: new Date().toISOString(),
            },
          ],
          allowed_mentions: { parse: [] },
        }),
      },
    );
  } catch (error) {
    console.warn(
      `Could not DM rearrangement security alert to ${userId}:`,
      error,
    );
  }
}

async function terminateCompromisedTicket(
  ticket: TicketPayload,
): Promise<void> {
  const newlyTerminated = await terminateTicket(ticket);
  if (newlyTerminated) {
    await sendRearrangeLinkTerminatedDm(ticket.userId);
  }
}

function renderRearrangePage(ticket: string, data: RearrangePageData): string {''',
)

replace_once(
    '''function authenticate(
  request: IncomingMessage,
  ticketToken: string | null,
): TicketPayload | undefined {
  const ticket = verifyPayload<TicketPayload>(ticketToken, "ticket");
  if (!ticket) return undefined;
  return sessionUserId(request) === ticket.userId ? ticket : undefined;
}''',
    '''async function authenticate(
  request: IncomingMessage,
  ticketToken: string | null,
): Promise<TicketPayload | undefined> {
  const ticket = verifyPayload<TicketPayload>(ticketToken, "ticket");
  if (!ticket || await isTicketTerminated(ticket)) return undefined;
  return sessionUserId(request) === ticket.userId ? ticket : undefined;
}''',
)

replace_once(
    '''  if (url.pathname === "/rearrange") {
    const ticketToken = url.searchParams.get("ticket");
    const ticket = verifyPayload<TicketPayload>(ticketToken, "ticket");
    if (!ticket || !ticketToken) {
      sendHtml(response, 400, renderErrorPage("This rearrangement link is invalid or expired."));
      return true;
    }

    if (sessionUserId(request) !== ticket.userId) {
      sendHtml(response, 200, renderAuthorizationPage(ticketToken));
      return true;
    }

    const data = await buildPageData(''',
    '''  if (url.pathname === "/rearrange") {
    const ticketToken = url.searchParams.get("ticket");
    const ticket = verifyPayload<TicketPayload>(ticketToken, "ticket");
    if (!ticket || !ticketToken) {
      sendHtml(response, 400, renderErrorPage("This rearrangement link is invalid or expired."));
      return true;
    }
    if (await isTicketTerminated(ticket)) {
      sendHtml(
        response,
        410,
        renderErrorPage("This rearrangement link has been terminated. Generate a new link and keep it private."),
      );
      return true;
    }

    const currentSessionUserId = sessionUserId(request);
    if (currentSessionUserId && currentSessionUserId !== ticket.userId) {
      await terminateCompromisedTicket(ticket);
      sendHtml(
        response,
        403,
        renderErrorPage("This rearrangement link was terminated because it was opened by a different Discord account."),
      );
      return true;
    }

    if (currentSessionUserId !== ticket.userId) {
      sendHtml(response, 200, renderAuthorizationPage(ticketToken));
      return true;
    }

    const data = await buildPageData(''',
)

replace_once(
    '''    if (!ticket || !ticketToken) {
      sendHtml(response, 400, renderErrorPage("This rearrangement link is invalid or expired."));
      return true;
    }
    if (!config.discordClientSecret) {''',
    '''    if (!ticket || !ticketToken) {
      sendHtml(response, 400, renderErrorPage("This rearrangement link is invalid or expired."));
      return true;
    }
    if (await isTicketTerminated(ticket)) {
      sendHtml(
        response,
        410,
        renderErrorPage("This rearrangement link has been terminated. Generate a new link and keep it private."),
      );
      return true;
    }
    if (!config.discordClientSecret) {''',
)

replace_once(
    '''    if (!state || !ticket || !code || !config.discordClientSecret) {
      sendHtml(response, 400, renderErrorPage("Discord authorization could not be verified."));
      return true;
    }

    const tokenResponse = await fetch''',
    '''    if (!state || !ticket || !code || !config.discordClientSecret) {
      sendHtml(response, 400, renderErrorPage("Discord authorization could not be verified."));
      return true;
    }
    if (await isTicketTerminated(ticket)) {
      sendHtml(
        response,
        410,
        renderErrorPage("This rearrangement link has already been terminated."),
      );
      return true;
    }

    const tokenResponse = await fetch''',
)

replace_once(
    '''    if (!discordUser?.id || discordUser.id !== ticket.userId) {
      sendHtml(
        response,
        403,
        renderErrorPage("You must authorize the same Discord account that ran the command."),
      );
      return true;
    }''',
    '''    if (!discordUser?.id) {
      sendHtml(
        response,
        502,
        renderErrorPage("Discord could not verify the authorized account."),
      );
      return true;
    }

    if (discordUser.id !== ticket.userId) {
      await terminateCompromisedTicket(ticket);
      sendHtml(
        response,
        403,
        renderErrorPage("This rearrangement link was terminated because a different Discord account attempted to authorize it."),
      );
      return true;
    }''',
)

replace_once(
    '''  if (url.pathname === "/api/rearrange") {
    const ticketToken = url.searchParams.get("ticket");
    const ticket = authenticate(request, ticketToken);
    if (!ticket) {''',
    '''  if (url.pathname === "/api/rearrange") {
    const ticketToken = url.searchParams.get("ticket");
    const parsedTicket = verifyPayload<TicketPayload>(ticketToken, "ticket");
    if (parsedTicket && await isTicketTerminated(parsedTicket)) {
      sendJson(response, 410, { error: "This rearrangement link was terminated." });
      return true;
    }
    const ticket = await authenticate(request, ticketToken);
    if (!ticket) {''',
)

path.write_text(text)

readme = Path("README.md")
readme_text = readme.read_text()
old = "OAuth access is limited to the `identify` scope. Rearrangement links expire, are bound to the Discord user who ran the command, and require a signed session cookie before badge data can be changed."
new = old + " If a different Discord account attempts to authorize a rearrangement link, Jadges permanently terminates that exact link and sends the owner a security-alert DM."
if old not in readme_text:
    raise SystemExit("README security paragraph was not found")
readme.write_text(readme_text.replace(old, new, 1))
