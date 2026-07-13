import type { Client } from "discord.js";
import { fetchSendableTextChannel } from "@/bot/channels";
import {
  getOnedriveConfig,
  getOnedriveNotifyChannelId,
  isOnedriveConfigured,
  type OnedriveConfig,
} from "@/bot/config";
import { logBot, logError, logWarn } from "@/bot/logger";
import { getBotStateStore } from "@/bot/store/botStateStore";
import { getExtractedDataStore } from "@/bot/store/extractedDataStore";
import { generateScreenshotData } from "@/lib/grok/screenshot";
import {
  downloadItemAsDataUrl,
  fetchDelta,
  itemRelativePath,
  listChildrenRecursive,
  moveItem,
  type DriveItem,
} from "@/lib/onedrive/client";
import { inferScreenshotMeta, isSupportedImage } from "@/lib/onedrive/pathParser";
import type { ExtractedDataRecord, ScreenshotDataType } from "@/lib/types";

/**
 * OneDrive screenshot monitor: the orchestration that turns new OneDrive images
 * into structured rows in `extracted_data`.
 *
 * v1 polls the Microsoft Graph Delta API (see `lib/onedrive/client.ts`) on a
 * schedule. For each new `.png/.jpg/.jpeg` under the monitored folder we infer
 * the week + data type from its path (`lib/onedrive/pathParser.ts`), send it to
 * Grok Vision with a type-specific prompt (`lib/grok/screenshot.ts`), and store
 * the result. Processing is best-effort per file: one failure is logged and the
 * batch continues so a single bad screenshot never stalls the pipeline.
 */

/** Outcome of a single sync/import run. */
export interface OnedriveSyncResult {
  /** False when OneDrive isn't configured (nothing was attempted). */
  configured: boolean;
  /** Number of screenshots successfully processed and stored. */
  processed: number;
  /** Number of image files skipped because they were already processed. */
  skipped: number;
  /** Number of image files that errored during processing. */
  failed: number;
  /** The stored records for processed screenshots (for building a reply/summary). */
  records: ExtractedDataRecord[];
}

/** Whether a drive item is a live (non-deleted) supported image file. */
function isProcessableImage(item: DriveItem): boolean {
  return Boolean(item.file && !item.deleted && isSupportedImage(item.name));
}

/**
 * Process a single OneDrive image item: infer its metadata, extract structured
 * data with Grok Vision, and persist it. Returns the stored record, or
 * `undefined` when the file was skipped (already processed). Throws on a genuine
 * failure so the caller can count it.
 */
async function processImageItem(
  config: OnedriveConfig,
  item: DriveItem,
): Promise<ExtractedDataRecord | undefined> {
  const monitoredPath = config.monitoredPath ?? "";
  const relativePath = itemRelativePath(item, monitoredPath);
  const sourcePath = monitoredPath ? `${monitoredPath}/${relativePath}` : relativePath;

  const store = getExtractedDataStore();
  if (await store.hasProcessedPath(sourcePath)) {
    logBot(`OneDrive: skipping already-processed screenshot "${sourcePath}".`);
    return undefined;
  }

  const { weekNumber, dataType } = inferScreenshotMeta(relativePath);
  logBot(
    `OneDrive: processing "${sourcePath}" (type=${dataType}` +
      `${weekNumber !== undefined ? `, week=${weekNumber}` : ""}).`,
  );

  const dataUrl = await downloadItemAsDataUrl(config, item);
  const { data, model } = await generateScreenshotData(dataUrl, dataType);

  const record = await store.saveExtractedData({
    dataType,
    weekNumber,
    data,
    model,
    sourcePath,
    sourceName: item.name,
  });

  // Optionally move the processed file so the monitored folder only holds
  // pending screenshots. Best-effort: a move failure must not fail the run.
  if (config.processedPath) {
    try {
      await moveItem(config, item, config.processedPath);
    } catch (error) {
      logWarn(`OneDrive: could not move "${sourcePath}" to processed folder.`);
      logError("OneDrive move failed", error);
    }
  }

  return record;
}

/**
 * Process a batch of drive items, counting outcomes and never throwing on a
 * single file's failure. Shared by the delta sync and the full-folder import.
 */
async function processItems(
  config: OnedriveConfig,
  items: DriveItem[],
): Promise<OnedriveSyncResult> {
  const result: OnedriveSyncResult = {
    configured: true,
    processed: 0,
    skipped: 0,
    failed: 0,
    records: [],
  };

  for (const item of items) {
    if (!isProcessableImage(item)) {
      continue;
    }
    try {
      const record = await processImageItem(config, item);
      if (record) {
        result.processed += 1;
        result.records.push(record);
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      result.failed += 1;
      logError(`OneDrive: failed to process "${item.name}"`, error);
    }
  }

  return result;
}

/**
 * Poll OneDrive for new screenshots via the Delta API and process them. The
 * delta link is loaded from and saved back to `bot_state` so each run only
 * fetches changes since the last one. Pass `{ full: true }` to ignore the stored
 * delta link and re-enumerate the whole monitored folder.
 */
export async function syncOnedrive(
  options: { full?: boolean } = {},
): Promise<OnedriveSyncResult> {
  const config = getOnedriveConfig();
  if (!isOnedriveConfigured(config)) {
    logWarn(
      "OneDrive is not configured (need ONEDRIVE_CLIENT_ID/SECRET/TENANT_ID + ONEDRIVE_MONITORED_PATH); skipping sync.",
    );
    return { configured: false, processed: 0, skipped: 0, failed: 0, records: [] };
  }

  const stateStore = getBotStateStore();
  const deltaLink = options.full ? undefined : await stateStore.getOnedriveDeltaLink();

  const { items, deltaLink: nextDeltaLink } = await fetchDelta(config, deltaLink);
  const result = await processItems(config, items);

  // Persist the new delta link so the next poll resumes from here.
  await stateStore.setOnedriveDeltaLink(nextDeltaLink);

  logBot(
    `OneDrive sync complete: ${result.processed} processed, ` +
      `${result.skipped} skipped, ${result.failed} failed.`,
  );
  return result;
}

/**
 * Re-scan a specific folder (relative to the drive root) and process every image
 * under it, ignoring the delta token. Backs the manual `/import-from-onedrive`
 * command. Already-processed files are skipped via the store's dedup check.
 */
export async function importFromOnedrivePath(
  folderPath: string,
): Promise<OnedriveSyncResult> {
  const config = getOnedriveConfig();
  if (!isOnedriveConfigured(config)) {
    logWarn("OneDrive is not configured; skipping import.");
    return { configured: false, processed: 0, skipped: 0, failed: 0, records: [] };
  }

  // monitoredPath is guaranteed present by isOnedriveConfigured() above; fall
  // back to it when no explicit path is supplied.
  const target = folderPath.trim().replace(/^\/+|\/+$/g, "") || config.monitoredPath!;
  logBot(`OneDrive: importing all screenshots under "${target}"...`);
  const items = await listChildrenRecursive(config, target);
  return processItems(config, items);
}

/**
 * Process a single screenshot supplied directly (e.g. a Discord attachment for
 * the manual `/process-screenshot` command). `imageUrl` may be a public URL or a
 * base64 `data:` URL. Week/type are inferred from `sourcePath` when not given.
 */
export async function processScreenshotFromUrl(input: {
  imageUrl: string;
  sourcePath: string;
  sourceName?: string;
  weekNumber?: number;
  dataType?: ScreenshotDataType;
}): Promise<ExtractedDataRecord> {
  const inferred = inferScreenshotMeta(input.sourcePath);
  const dataType = input.dataType ?? inferred.dataType;
  const weekNumber = input.weekNumber ?? inferred.weekNumber;

  const { data, model } = await generateScreenshotData(input.imageUrl, dataType);

  return getExtractedDataStore().saveExtractedData({
    dataType,
    weekNumber,
    data,
    model,
    sourcePath: input.sourcePath,
    sourceName: input.sourceName,
  });
}

/**
 * Post a short summary of a processing run to the configured notify channel so
 * the league can see new data land without watching the logs. Best-effort: any
 * failure is logged and swallowed. Silent when nothing was processed or no
 * channel is configured.
 */
export async function notifyOnedriveResult(
  client: Client,
  result: OnedriveSyncResult,
): Promise<void> {
  if (result.processed === 0) {
    return;
  }

  const channelId = getOnedriveNotifyChannelId();
  if (!channelId) {
    return;
  }

  try {
    const channel = await fetchSendableTextChannel(client, channelId);
    if (!channel) {
      logWarn(`OneDrive notify channel ${channelId} is not a sendable text channel.`);
      return;
    }

    const byType = new Map<ScreenshotDataType, number>();
    for (const record of result.records) {
      byType.set(record.dataType, (byType.get(record.dataType) ?? 0) + 1);
    }
    const breakdown = Array.from(byType.entries())
      .map(([type, count]) => `${count}× ${type}`)
      .join(", ");

    await channel.send(
      `📥 Imported **${result.processed}** screenshot(s) from OneDrive` +
        (breakdown ? ` (${breakdown}).` : "."),
    );
  } catch (error) {
    logError("Failed to post OneDrive import summary", error);
  }
}

const globalForMonitor = globalThis as typeof globalThis & {
  onedriveMonitorStarted?: boolean;
  onedriveMonitorTimer?: ReturnType<typeof setInterval>;
  onedriveMonitorRunning?: boolean;
};

/**
 * Run one poll tick, guarding against overlapping runs (a slow Grok Vision batch
 * must not overlap the next tick) and posting a summary when files were processed.
 */
async function runMonitorTick(client: Client): Promise<void> {
  if (globalForMonitor.onedriveMonitorRunning) {
    logBot("OneDrive: previous poll still running; skipping this tick.");
    return;
  }
  globalForMonitor.onedriveMonitorRunning = true;
  try {
    const result = await syncOnedrive();
    await notifyOnedriveResult(client, result);
  } finally {
    globalForMonitor.onedriveMonitorRunning = false;
  }
}

/**
 * Start the background OneDrive poller. Idempotent (guarded by a global flag so
 * hot reloads don't stack timers) and a no-op when OneDrive isn't configured.
 * Called from the Discord client's `ClientReady` handler alongside the reminder
 * scheduler.
 */
export function startOnedriveMonitor(client: Client): void {
  if (globalForMonitor.onedriveMonitorStarted) {
    return;
  }

  const config = getOnedriveConfig();
  if (!isOnedriveConfigured(config)) {
    logBot("OneDrive monitor not started (not configured).");
    return;
  }

  globalForMonitor.onedriveMonitorStarted = true;
  logBot(
    `Starting OneDrive monitor for "${config.monitoredPath}" ` +
      `(polling every ${Math.round(config.pollIntervalMs / 1000)}s).`,
  );

  // Run one poll immediately so a freshly-dropped screenshot isn't delayed a
  // full interval, then on the configured cadence.
  void runMonitorTick(client).catch((error) =>
    logError("Initial OneDrive poll failed", error),
  );

  const timer = setInterval(() => {
    void runMonitorTick(client).catch((error) =>
      logError("OneDrive poll failed", error),
    );
  }, config.pollIntervalMs);

  // Don't keep the event loop alive solely for this timer.
  timer.unref?.();
  globalForMonitor.onedriveMonitorTimer = timer;
}
