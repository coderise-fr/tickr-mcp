import type { TickrApi } from "../api/client.js";
import { ApiHttpError, ApiProblemError, ToolError } from "../api/errors.js";
import type { MeDto, RoleCode } from "../api/types.js";
import type { Access } from "./tool.js";

export const TOO_OLD =
  "This Tickr instance is too old for this MCP server: it does not provide GET /api/v1/me. Ask your Tickr administrator to upgrade Tickr.";

export const READ_ONLY_KEY =
  "This API key has the analyst role, which is read-only: it cannot start, stop, create or change entries.";

export const BAD_ME_CONTRACT =
  "Tickr returned an unexpected answer to GET /api/v1/me (missing or unknown key role), so this MCP server cannot " +
  "check the key's permissions and refuses to act. Upgrade the MCP server or contact your Tickr administrator.";

const KNOWN_ROLES: readonly RoleCode[] = ["owner", "admin", "project_lead", "analyst", "workspace_user"];

export const elevatedKeyMessage = (role: RoleCode): string =>
  `This API key has the ${role} role, which can change other members' entries. For safety, the Tickr MCP server only ` +
  `accepts keys limited to their owner's own entries. In Tickr, open Settings → API keys, create a key with the ` +
  `"Workspace user" role, and put it in the MCP server configuration (TICKR_API_KEY).`;

export async function fetchMe(api: TickrApi): Promise<MeDto> {
  try {
    return await api.me();
  } catch (e) {
    const status = e instanceof ApiProblemError || e instanceof ApiHttpError ? e.status : undefined;
    if (status === 404) throw new ToolError(TOO_OLD);
    throw e;
  }
}

/** Spec §3.1. Caches the key's frozen role only; it is immutable for the key's lifetime. */
export class KeyGate {
  private keyRole: RoleCode | undefined;

  constructor(private readonly api: TickrApi) {}

  async check(access: Access): Promise<void> {
    if (this.keyRole === undefined) {
      // The client checks the rest of /me; keyRole is checked here, before caching.
      const raw: unknown = (await fetchMe(this.api)).keyRole;
      if (typeof raw !== "string" || !KNOWN_ROLES.includes(raw as RoleCode)) throw new ToolError(BAD_ME_CONTRACT);
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
