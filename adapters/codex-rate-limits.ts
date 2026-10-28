import * as fs from "fs/promises";
import { randomUUID } from "crypto";
import { dirname, join } from "path";

function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function windowFromHeaders(
  headers: Headers,
  window: string,
  minutes: number,
  capturedAt: number,
) {
  const prefix = `x-codex-${window}`;
  const used = numberHeader(headers, `${prefix}-used-percent`);
  const duration = numberHeader(headers, `${prefix}-window-minutes`);
  const absolute = numberHeader(headers, `${prefix}-reset-at`);
  const relative = numberHeader(headers, `${prefix}-reset-after-seconds`);
  // Присутствующий, но повреждённый срок нельзя подменять запасным значением.
  if (headers.has(`${prefix}-reset-at`) && !Number.isSafeInteger(absolute))
    return;
  if (
    headers.has(`${prefix}-reset-after-seconds`) &&
    !Number.isSafeInteger(relative)
  )
    return;
  const resetsAt =
    absolute ?? (relative === undefined ? undefined : capturedAt + relative);
  if (
    used === undefined ||
    used > 100 ||
    duration !== minutes ||
    resetsAt === undefined ||
    !Number.isSafeInteger(resetsAt) ||
    resetsAt <= capturedAt
  )
    return;
  return { used_percentage: used, resets_at: resetsAt };
}

export async function captureCodexRateLimits(headers: Headers): Promise<void> {
  const destination = process.env.CODEX_PROXY_RATE_LIMITS_FILE;
  if (!destination) return;
  const capturedAt = Math.floor(Date.now() / 1000);
  const fiveHour = windowFromHeaders(headers, "primary", 300, capturedAt);
  const sevenDay = windowFromHeaders(headers, "secondary", 10080, capturedAt);
  if (!fiveHour || !sevenDay) return;

  const temporary = join(
    dirname(destination),
    `.codex-rate-limits-${randomUUID()}.tmp`,
  );
  let created = false;
  try {
    // Исключительное создание защищает от совпадений имён и чужих ссылок.
    const file = await fs.open(temporary, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(
        JSON.stringify({
          capturedAt,
          five_hour: fiveHour,
          seven_day: sevenDay,
        }),
      );
    } finally {
      await file.close();
    }
    await fs.rename(temporary, destination);
  } catch {
    // Пути, заголовки и текст исключения могут содержать приватные данные.
    console.error("[codex-proxy] Не удалось записать снимок квоты.");
  } finally {
    if (created) await fs.unlink(temporary).catch(() => {});
  }
}
