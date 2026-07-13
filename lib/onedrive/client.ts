import type { OnedriveConfig } from "@/bot/config";

/**
 * Thin Microsoft Graph client for the OneDrive screenshot monitor.
 *
 * v1 uses **polling via the Graph Delta API** (simplest to operate): the caller
 * persists the returned `deltaLink` and passes it back next time so only changes
 * since the last poll are fetched. Upgrading to webhooks/subscriptions later
 * only touches the monitor loop, not this module.
 *
 * Authentication uses the OAuth2 client-credentials (app-only) flow with the
 * configured Azure AD app. Tokens are cached in-process until shortly before
 * they expire. Networking is plain `fetch` so there is no new dependency.
 */

/** Base URL for Graph v1.0. */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** A OneDrive item as returned by Graph (only the fields we use). */
export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  /** Present on files; carries the MIME type. */
  file?: { mimeType?: string };
  /** Present on folders. */
  folder?: { childCount?: number };
  /** Present when the item was deleted (delta responses include tombstones). */
  deleted?: { state?: string };
  parentReference?: {
    driveId?: string;
    /** e.g. "/drive/root:/Xbox Screenshots/2026 Week 2". */
    path?: string;
  };
  /** Short-lived pre-authenticated download URL (present on files in listings). */
  "@microsoft.graph.downloadUrl"?: string;
}

/** Result of a delta query: the changed items plus the next delta link. */
export interface DeltaResult {
  items: DriveItem[];
  /** Persist this and pass it as `deltaLink` next time to fetch only changes. */
  deltaLink: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface DriveItemPage {
  value?: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** In-process token cache, keyed by client id so multiple configs don't clash. */
const globalForOnedrive = globalThis as typeof globalThis & {
  onedriveTokenCache?: Map<string, { token: string; expiresAt: number }>;
};

function tokenCache(): Map<string, { token: string; expiresAt: number }> {
  if (!globalForOnedrive.onedriveTokenCache) {
    globalForOnedrive.onedriveTokenCache = new Map();
  }
  return globalForOnedrive.onedriveTokenCache;
}

/** Build the HTTP Authorization header value for a Graph access token. */
function bearer(token: string): string {
  return "Bearer " + token;
}

/** Encode a folder path for use in a Graph `root:/{path}:` address. */
function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Acquire (and cache) an app-only Graph access token via client credentials. */
async function getAccessToken(config: OnedriveConfig): Promise<string> {
  const { clientId, clientSecret, tenantId } = config;
  if (!clientId || !clientSecret || !tenantId) {
    throw new Error("OneDrive is not fully configured (missing client credentials).");
  }

  const cache = tokenCache();
  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `OneDrive auth failed (${response.status} ${response.statusText}): ${errorBody}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  // Refresh a minute early to avoid using a token that expires mid-request.
  const expiresAt = Date.now() + Math.max(data.expires_in - 60, 30) * 1000;
  cache.set(clientId, { token: data.access_token, expiresAt });
  return data.access_token;
}

/** The Graph drive base for this config (`/drives/{id}` or `/me/drive`). */
function driveBase(config: OnedriveConfig): string {
  return config.driveId
    ? `${GRAPH_BASE}/drives/${encodeURIComponent(config.driveId)}`
    : `${GRAPH_BASE}/me/drive`;
}

/** Perform an authenticated Graph GET returning parsed JSON. */
async function graphGet<T>(config: OnedriveConfig, url: string): Promise<T> {
  const token = await getAccessToken(config);
  const response = await fetch(url, {
    headers: { Authorization: bearer(token) },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `OneDrive request failed (${response.status} ${response.statusText}): ${errorBody}`,
    );
  }

  return (await response.json()) as T;
}

/**
 * Fetch changes to the monitored folder via the Delta API.
 *
 * When `deltaLink` is provided it is followed directly (only changes since it
 * was issued are returned). Otherwise a fresh delta enumeration of
 * `config.monitoredPath` is started. All `@odata.nextLink` pages are followed so
 * the returned `items` are complete and `deltaLink` is the final token to persist.
 */
export async function fetchDelta(
  config: OnedriveConfig,
  deltaLink?: string,
): Promise<DeltaResult> {
  if (!config.monitoredPath) {
    throw new Error("OneDrive monitored path is not configured.");
  }

  let url =
    deltaLink ??
    `${driveBase(config)}/root:/${encodePath(config.monitoredPath)}:/delta`;

  const items: DriveItem[] = [];
  let nextDeltaLink: string | undefined;

  // Follow pagination until Graph returns a deltaLink (end of the change set).
  // Guard against a pathological loop with a generous page cap.
  for (let page = 0; page < 1000; page += 1) {
    const data = await graphGet<DriveItemPage>(config, url);
    if (Array.isArray(data.value)) {
      items.push(...data.value);
    }

    if (data["@odata.deltaLink"]) {
      nextDeltaLink = data["@odata.deltaLink"];
      break;
    }
    if (!data["@odata.nextLink"]) {
      break;
    }
    url = data["@odata.nextLink"];
  }

  return { items, deltaLink: nextDeltaLink ?? deltaLink ?? url };
}

/**
 * Recursively list every item under `folderPath` (relative to the drive root).
 * Used by the manual `/import-from-onedrive` command to re-scan a folder without
 * touching the delta token.
 */
export async function listChildrenRecursive(
  config: OnedriveConfig,
  folderPath: string,
): Promise<DriveItem[]> {
  const results: DriveItem[] = [];

  const walk = async (path: string): Promise<void> => {
    let url = `${driveBase(config)}/root:/${encodePath(path)}:/children`;
    for (let page = 0; page < 1000; page += 1) {
      const data = await graphGet<DriveItemPage>(config, url);
      for (const item of data.value ?? []) {
        results.push(item);
        if (item.folder) {
          await walk(`${path}/${item.name}`);
        }
      }
      if (!data["@odata.nextLink"]) {
        break;
      }
      url = data["@odata.nextLink"];
    }
  };

  await walk(folderPath);
  return results;
}

/**
 * Download a drive item and return it as a base64 `data:` URL suitable for the
 * Grok Vision `analyzeImages` call. Uses the item's short-lived pre-authenticated
 * download URL when present, otherwise falls back to the authenticated `/content`
 * endpoint.
 */
export async function downloadItemAsDataUrl(
  config: OnedriveConfig,
  item: DriveItem,
): Promise<string> {
  const downloadUrl = item["@microsoft.graph.downloadUrl"];
  let response: Response;

  if (downloadUrl) {
    response = await fetch(downloadUrl);
  } else {
    const token = await getAccessToken(config);
    response = await fetch(
      `${driveBase(config)}/items/${encodeURIComponent(item.id)}/content`,
      { headers: { Authorization: bearer(token) } },
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download "${item.name}" (${response.status} ${response.statusText}).`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const mime = item.file?.mimeType || "image/png";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Move a processed item into `destFolderPath` (relative to the drive root),
 * creating a clean audit trail of handled screenshots. Best-effort: the caller
 * decides whether a move failure should abort processing (it should not).
 */
export async function moveItem(
  config: OnedriveConfig,
  item: DriveItem,
  destFolderPath: string,
): Promise<void> {
  const token = await getAccessToken(config);
  const response = await fetch(
    `${driveBase(config)}/items/${encodeURIComponent(item.id)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: bearer(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parentReference: { path: `/drive/root:/${encodePath(destFolderPath)}` },
      }),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to move "${item.name}" (${response.status} ${response.statusText}): ${errorBody}`,
    );
  }
}

/**
 * Compute an item's path relative to `monitoredPath`, including the filename
 * (e.g. "2026 Week 2/Box Scores/final.png"). Falls back to just the item name
 * when the parent path can't be resolved. The returned path feeds the
 * folder/type inference in `pathParser.ts`.
 */
export function itemRelativePath(item: DriveItem, monitoredPath: string): string {
  const rawParent = item.parentReference?.path;
  if (!rawParent) {
    return item.name;
  }

  // parentReference.path looks like "/drive/root:/Folder/Sub" — take the part
  // after "root:" and decode the percent-encoding Graph applies.
  const afterRoot = rawParent.split("root:").pop() ?? "";
  const decoded = decodeURIComponent(afterRoot).replace(/^\/+/, "");

  // Strip the monitored root prefix so the remaining path is relative to it.
  const normalizedMonitored = monitoredPath.replace(/^\/+|\/+$/g, "");
  let relativeDir = decoded;
  if (normalizedMonitored && decoded.startsWith(normalizedMonitored)) {
    relativeDir = decoded.slice(normalizedMonitored.length).replace(/^\/+/, "");
  }

  return relativeDir ? `${relativeDir}/${item.name}` : item.name;
}
