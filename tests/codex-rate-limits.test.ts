import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { captureCodexRateLimits } from "../adapters/codex-rate-limits.js";
import { createGateway } from "../adapters/anthropic-gateway.js";

vi.mock("fs/promises", async (original) => {
  const actual = await original<typeof import("fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const now = 1790000000;
let root: string;
let destination: string;
function headers() {
  return new Headers({
    "x-codex-primary-used-percent": "12.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(now + 3600),
    "x-codex-secondary-used-percent": "76",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(now + 604800),
  });
}
const expected = {
  capturedAt: now,
  five_hour: { used_percentage: 12.5, resets_at: now + 3600 },
  seven_day: { used_percentage: 76, resets_at: now + 604800 },
};
beforeEach(async () => {
  const actual =
    await vi.importActual<typeof import("fs/promises")>("fs/promises");
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  root = await fs.mkdtemp(join(tmpdir(), "quota-test-"));
  destination = join(root, "codex-rate-limits.json");
  vi.stubEnv("HOME", root);
  vi.stubEnv("CODEX_HOME", root);
  vi.stubEnv("CODEX_AUTH_FILE", "");
  vi.stubEnv("CODEX_PROXY_RATE_LIMITS_FILE", destination);
  vi.stubEnv("CCX_NETWORK_RETRIES", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Внешние запросы запрещены");
    }),
  );
  vi.spyOn(Date, "now").mockReturnValue(now * 1000 + 789);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Снимок окон квоты", () => {
  it("сохраняет оба окна в формате потребителя с правами 0600", async () => {
    await captureCodexRateLimits(headers());
    expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual(
      expected,
    );
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
  });

  it("переводит относительный срок в абсолютные секунды Unix", async () => {
    const input = headers();
    for (const [window, seconds] of [
      ["primary", 3600],
      ["secondary", 604800],
    ] as const) {
      input.delete(`x-codex-${window}-reset-at`);
      input.set(`x-codex-${window}-reset-after-seconds`, String(seconds));
    }
    await captureCodexRateLimits(input);
    expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual(
      expected,
    );
  });

  it("предпочитает абсолютный срок и принимает граничные проценты", async () => {
    const input = headers();
    input.set("x-codex-primary-reset-after-seconds", "123");
    input.set("x-codex-primary-used-percent", "0");
    input.set("x-codex-secondary-used-percent", "100");
    await captureCodexRateLimits(input);
    expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual({
      ...expected,
      five_hour: { ...expected.five_hour, used_percentage: 0 },
      seven_day: { ...expected.seven_day, used_percentage: 100 },
    });
  });

  it.each([
    ["primary-used-percent", null],
    ["secondary-used-percent", null],
    ["primary-reset-at", null],
    ["secondary-window-minutes", null],
    ["primary-used-percent", ""],
    ["primary-used-percent", "101"],
    ["secondary-used-percent", "-1"],
    ["primary-used-percent", "NaN"],
    ["primary-used-percent", "Infinity"],
    ["primary-used-percent", "12oops"],
    ["primary-window-minutes", "10080"],
    ["secondary-window-minutes", "300"],
    ["primary-reset-at", String(now)],
    ["secondary-reset-at", String(now - 1)],
    ["primary-reset-at", "1790003600.5"],
    ["primary-reset-at", "9007199254740992"],
    ["primary-reset-at", "broken"],
    ["primary-reset-after-seconds", "broken"],
  ])("оставляет прежний файл при повреждённом %s=%s", async (suffix, value) => {
    const input = headers();
    if (value === null) input.delete(`x-codex-${suffix}`);
    else input.set(`x-codex-${suffix}`, value);
    await fs.writeFile(destination, "прежний снимок");
    await captureCodexRateLimits(input);
    expect(await fs.readFile(destination, "utf8")).toBe("прежний снимок");
    expect(await fs.readdir(root)).toEqual(["codex-rate-limits.json"]);
  });

  it("без заголовков не меняет содержимое и метаданные прежнего файла", async () => {
    await fs.writeFile(destination, "прежний снимок");
    const before = await fs.stat(destination);
    await captureCodexRateLimits(new Headers());
    expect(await fs.readFile(destination, "utf8")).toBe("прежний снимок");
    expect((await fs.stat(destination)).mtimeMs).toBe(before.mtimeMs);
  });

  it("без переменной окружения не создаёт файлов", async () => {
    vi.stubEnv("CODEX_PROXY_RATE_LIMITS_FILE", "");
    await captureCodexRateLimits(headers());
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("атомарно заменяет прежний файл через временный файл в том же каталоге", async () => {
    await fs.writeFile(destination, "прежний снимок", { mode: 0o644 });
    const originalRename = (
      await vi.importActual<typeof import("fs/promises")>("fs/promises")
    ).rename;
    const rename = vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      expect(dirname(String(from))).toBe(dirname(destination));
      expect(from).not.toBe(destination);
      expect(to).toBe(destination);
      expect(await fs.readFile(destination, "utf8")).toBe("прежний снимок");
      expect(JSON.parse(await fs.readFile(from, "utf8"))).toEqual(expected);
      expect((await fs.stat(from)).mode & 0o777).toBe(0o600);
      await originalRename(from, to);
    });
    await captureCodexRateLimits(headers());
    expect(rename).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual(
      expected,
    );
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(root)).toEqual(["codex-rate-limits.json"]);
  });

  it("ошибка переименования оставляет прежний файл и удаляет временный", async () => {
    await fs.writeFile(destination, "прежний снимок");
    vi.mocked(fs.rename).mockRejectedValue(new Error("секретный путь и токен"));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(captureCodexRateLimits(headers())).resolves.toBeUndefined();
    expect(await fs.readFile(destination, "utf8")).toBe("прежний снимок");
    expect(await fs.readdir(root)).toEqual(["codex-rate-limits.json"]);
    expect(stderr.mock.calls).toEqual([
      ["[codex-proxy] Не удалось записать снимок квоты."],
    ]);
  });

  it.each([true, false, 429, 503, "ошибка записи"])(
    "подключает запись к ответу сервера: %s",
    async (mode) => {
      await fs.writeFile(
        join(root, "auth.json"),
        JSON.stringify({
          tokens: {
            access_token: `synthetic.${Buffer.from(JSON.stringify({ exp: now + 3600 })).toString("base64url")}.signature`,
            account_id: "synthetic-account",
          },
        }),
      );
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      if (mode === "ошибка записи")
        vi.stubEnv(
          "CODEX_PROXY_RATE_LIMITS_FILE",
          join(root, "нет-каталога", "quota.json"),
        );
      const status = typeof mode === "number" ? mode : 200;
      const input = headers();
      const body =
        status === 200
          ? `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                output: [
                  {
                    type: "message",
                    content: [
                      { type: "output_text", text: "синтетический ответ" },
                    ],
                  },
                ],
              },
            })}\n\n`
          : JSON.stringify({ error: { code: "rate_limit_exceeded" } });
      vi.mocked(fetch).mockResolvedValue(
        new Response(body, { status, headers: input }),
      );
      const app = createGateway();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages",
          payload: {
            model: "gpt-6.1-sol",
            stream: mode === true,
            messages: [{ role: "user", content: "синтетический запрос" }],
          },
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        if (mode === "ошибка записи") {
          expect(stderr.mock.calls).toEqual([
            ["[codex-proxy] Не удалось записать снимок квоты."],
          ]);
          await expect(fs.access(destination)).rejects.toThrow();
        } else {
          expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual(
            expected,
          );
        }
        expect(response.body).toContain(
          status === 200 ? "синтетический ответ" : "error",
        );
      } finally {
        await app.close();
      }
    },
  );
});
