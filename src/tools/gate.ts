import type { TickrApi } from "../api/client.js";
import { ApiHttpError, ApiProblemError, ToolError } from "../api/errors.js";
import { ROLE_CODES, type MeDto, type RoleCode } from "../api/types.js";
import type { Access } from "./tool.js";

export const TOO_OLD =
  "This Tickr instance is too old for this MCP server: it does not provide GET /api/v1/me. Ask your Tickr administrator to upgrade Tickr.";

export const TOO_OLD_OR_NOT_TICKR =
  TOO_OLD + " Or TICKR_BASE_URL does not point to a Tickr instance: check the configured address.";

export const READ_ONLY_KEY =
  "This API key has the analyst role, which is read-only: it cannot start, stop, create or change entries.";

export const BAD_ME_CONTRACT =
  "Tickr returned an unexpected answer to GET /api/v1/me (missing or unknown key role), so this MCP server cannot " +
  "check the key's permissions and refuses to act. Upgrade the MCP server or contact your Tickr administrator.";

export const elevatedKeyMessage = (role: RoleCode): string =>
  `This API key has the ${role} role, which can change other members' entries. For safety, the Tickr MCP server only ` +
  `accepts keys limited to their owner's own entries. In Tickr, open Settings → API keys, create a key with the ` +
  `"Workspace user" role, and put it in the MCP server configuration (TICKR_API_KEY).`;

export async function fetchMe(api: TickrApi): Promise<MeDto> {
  try {
    return await api.me();
  } catch (e) {
    // A Tickr problem document proves the address is a Tickr instance; a bare 404 does not.
    if (e instanceof ApiProblemError && e.status === 404) throw new ToolError(TOO_OLD);
    if (e instanceof ApiHttpError && e.status === 404) throw new ToolError(TOO_OLD_OR_NOT_TICKR);
    throw e;
  }
}

/**
 * Key-role gate, checked before every tool call: only keys limited to their owner's own entries
 * may act. Caches the key's frozen role only; it is immutable for the key's lifetime.
 */
export class KeyGate {
  private keyRole: RoleCode | undefined;

  constructor(private readonly api: TickrApi) {}

  async check(access: Access): Promise<void> {
    if (this.keyRole === undefined) {
      // The client checks the rest of /me; keyRole is checked here, before caching.
      const raw: unknown = (await fetchMe(this.api)).keyRole;
      if (typeof raw !== "string" || !(ROLE_CODES as readonly string[]).includes(raw)) throw new ToolError(BAD_ME_CONTRACT);
      this.keyRole = raw as RoleCode;
    }
    // Allow-list: anything not explicitly allowed is refused.
    const role = this.keyRole;
    if (role === "workspace_user" || role === "project_lead") return;
    if (role === "analyst") {
      if (access === "read") return;
      throw new ToolError(READ_ONLY_KEY);
    }
    throw new ToolError(elevatedKeyMessage(role));
  }
}
