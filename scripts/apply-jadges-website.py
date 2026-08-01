from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"Expected block not found in {path}:\n{old[:240]}")
    path.write_text(text.replace(old, new, 1))


server = Path("src/server.ts")
replace_once(
    server,
    'import { handleRearrangeRequest } from "./rearrange.js";\n',
    'import { handleRearrangeRequest } from "./rearrange.js";\nimport { handleWebsiteRequest } from "./website.js";\n',
)
replace_once(
    server,
    '''      if (\n        url.pathname === "/rearrange"\n        || url.pathname === "/api/rearrange"\n      ) {\n        await ensureJaycordStaffMembersFresh();\n      }\n\n      if (\n        await handleRearrangeRequest(''',
    '''      if (\n        url.pathname === "/rearrange"\n        || url.pathname === "/api/rearrange"\n        || url.pathname === "/dashboard"\n        || url.pathname === "/api/dashboard"\n      ) {\n        await ensureJaycordStaffMembersFresh();\n      }\n\n      if (\n        await handleWebsiteRequest(\n          request,\n          response,\n          url,\n          origin,\n          (userId, user) => systemStaffBadgeForUser(userId, user),\n        )\n      ) {\n        return;\n      }\n\n      if (\n        await handleRearrangeRequest(''',
)
replace_once(
    server,
    '''      if (url.pathname === "/" || url.pathname === "/health") {\n        sendJson(response, 200, { ok: true, service: "Jadges" });\n        return;\n      }''',
    '''      if (url.pathname === "/health") {\n        sendJson(response, 200, { ok: true, service: "Jadges" });\n        return;\n      }''',
)

rearrange = Path("src/rearrange.ts")
replace_once(
    rearrange,
    '''    const data = await buildPageData(\n      ticket.userId,\n      origin,\n      resolveSystemStaffBadge,\n    );\n    sendHtml(response, 200, renderRearrangePage(ticketToken, data));\n    return true;''',
    '''    redirect(response, "/dashboard");\n    return true;''',
)
replace_once(
    rearrange,
    '''    redirect(response, `/rearrange?ticket=${encodeURIComponent(state.ticket)}`);\n    return true;''',
    '''    redirect(response, "/dashboard");\n    return true;''',
)

security = Path("src/rearrangeSecurity.ts")
replace_once(
    security,
    '''  response.writeHead(302, { location: `/rearrange?ticket=${encodeURIComponent(state.ticket)}`, "cache-control": "no-store" });''',
    '''  response.writeHead(302, { location: "/dashboard", "cache-control": "no-store" });''',
)
replace_once(
    security,
    '''  if (url.pathname === "/oauth/callback") {\n    await oauthCallback(response, url);\n    return true;\n  }''',
    '''  if (url.pathname === "/oauth/callback") {\n    const state = verify<State>(url.searchParams.get("state"), "state");\n    const ticket = state ? verify<Ticket>(state.ticket, "ticket") : undefined;\n    if (!state || !ticket) return false;\n    await oauthCallback(response, url);\n    return true;\n  }''',
)
