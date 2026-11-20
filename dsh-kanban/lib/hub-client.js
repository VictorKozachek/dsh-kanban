/** Клиент хаба для claim/release/handoff из CLI (M2, #073). */
import fs from "node:fs";
import path from "node:path";

export function hubSettingsFromBoard(board, overrides = {}) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(board, ".kanban", "sync.json"), "utf8"));
  } catch {}
  const env = process.env;
  return {
    hubUrl: String(overrides.hubUrl ?? file.hubUrl ?? env.KANBAN_HUB_URL ?? "").replace(/\/+$/, ""),
    project: String(overrides.project ?? file.project ?? env.KANBAN_HUB_PROJECT ?? "default"),
    token: String(overrides.token ?? file.token ?? env.KANBAN_HUB_TOKEN ?? ""),
    instanceId: String(overrides.instanceId ?? file.instanceId ?? env.KANBAN_HUB_INSTANCE ?? "cli"),
    userId: String(overrides.userId ?? file.userId ?? env.KANBAN_HUB_USER ?? ""),
  };
}

async function call(settings, method, suffix, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${settings.hubUrl}/v1/projects/${encodeURIComponent(settings.project)}${suffix}`, {
    method,
    headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

export function claimCard(settings, card, { ttlSeconds } = {}, fetchImpl) {
  return call(settings, "POST", `/cards/${encodeURIComponent(card)}/claim`, {
    instance: settings.instanceId,
    user: settings.userId || settings.instanceId,
    ...(ttlSeconds ? { ttl_seconds: ttlSeconds } : {}),
  }, fetchImpl);
}

export function releaseCard(settings, card, fetchImpl) {
  return call(settings, "POST", `/cards/${encodeURIComponent(card)}/release`, { instance: settings.instanceId }, fetchImpl);
}

export function handoffCard(settings, card, assignee, fetchImpl) {
  return call(settings, "POST", `/cards/${encodeURIComponent(card)}/handoff`, {
    instance: settings.instanceId,
    assignee,
  }, fetchImpl);
}
