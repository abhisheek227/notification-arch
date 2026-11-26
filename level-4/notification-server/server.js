const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db } = require("./db");
const { TTLCache, renderTemplate, evaluatePreferences } = require("./engine");

const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const DEFAULT_TENANT = "tenant-1";
const DEFAULT_USER = "user-1";

// In-memory cache (preferences, templates, deduplication)
const cache = new TTLCache(60_000);

// Connected SSE clients keyed by user_id -> Set<res>
const sseClients = new Map();

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1e6) {
                reject(new Error("Payload too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Invalid JSON"));
            }
        });
        req.on("error", reject);
    });
}

function serveStaticFile(reqPath, res) {
    const safePath = reqPath === "/" ? "/index.html" : reqPath;
    const filePath = path.join(FRONTEND_DIR, path.normalize(safePath));
    if (!filePath.startsWith(FRONTEND_DIR)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(content);
    });
}

function emitToUser(userId, eventName, data) {
    const conns = sseClients.get(userId);
    if (!conns || conns.size === 0) return 0;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of conns) {
        res.write(frame);
    }
    return conns.size;
}

function getSettingByEventKey(eventKey) {
    const cacheKey = `setting:${eventKey}`;
    let row = cache.get(cacheKey);
    if (!row) {
        row = db.prepare("SELECT * FROM notification_setting WHERE event_key = ?").get(eventKey);
        if (row) cache.set(cacheKey, row);
    }
    return row;
}

function getUserSetting(tenantId, userId, settingId) {
    const cacheKey = `user_setting:${tenantId}:${userId}:${settingId}`;
    let row = cache.get(cacheKey);
    if (row === undefined) {
        row =
            db
                .prepare(
                    "SELECT * FROM notification_user_setting WHERE tenant_id = ? AND user_id = ? AND setting_id = ?"
                )
                .get(tenantId, userId, settingId) || null;
        cache.set(cacheKey, row);
    }
    return row;
}

function getActiveTemplate(settingId, channel, locale = "en") {
    const cacheKey = `template:${settingId}:${channel}:${locale}`;
    let row = cache.get(cacheKey);
    if (!row) {
        row = db
            .prepare(
                "SELECT * FROM notification_template WHERE setting_id = ? AND channel = ? AND locale = ? AND is_active = 1"
            )
            .get(settingId, channel, locale);
        if (row) cache.set(cacheKey, row);
    }
    return row;
}

// Core Notification Orchestrator (called by Server 1: Producer Server)
function dispatchNotification(input) {
    const {
        event_key,
        tenant_id = DEFAULT_TENANT,
        user_id = DEFAULT_USER,
        severity = "INFO",
        payload = {},
        idempotency_key,
    } = input;

    if (!event_key) {
        return { status: 400, body: { error: "event_key is required" } };
    }

    const setting = getSettingByEventKey(event_key);
    if (!setting) {
        return { status: 404, body: { error: `Unknown event_key: ${event_key}` } };
    }

    // Deduplication check
    const dedupeKey = idempotency_key || `${event_key}:${tenant_id}:${user_id}:${crypto.randomUUID()}`;
    if (idempotency_key && !cache.setIfAbsent(`dedupe:${idempotency_key}`, true, 300_000)) {
        return { status: 200, body: { status: "DUPLICATE_IGNORED", idempotency_key } };
    }

    const userSetting = getUserSetting(tenant_id, user_id, setting.id);
    const decision = evaluatePreferences(setting, userSetting, payload, severity);

    // Fetch primary IN_APP template for record snapshot
    const primaryTemplate =
        getActiveTemplate(setting.id, "IN_APP") || getActiveTemplate(setting.id, "PUSH");
    const rendered = primaryTemplate
        ? renderTemplate(primaryTemplate, { ...payload, severity })
        : { title: event_key, body: JSON.stringify(payload), action_url: "" };

    const notificationId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
        db.prepare(`
            INSERT INTO notification
                (id, tenant_id, user_id, setting_id, template_id, idempotency_key, severity, payload, rendered_content, is_read, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).run(
            notificationId,
            tenant_id,
            user_id,
            setting.id,
            primaryTemplate ? primaryTemplate.id : null,
            dedupeKey,
            severity,
            JSON.stringify(payload),
            JSON.stringify(rendered),
            now
        );
    } catch (err) {
        if (String(err.message).includes("UNIQUE")) {
            return { status: 200, body: { status: "DUPLICATE_IGNORED", idempotency_key: dedupeKey } };
        }
        throw err;
    }

    const insertDelivery = db.prepare(`
        INSERT INTO notification_delivery (id, notification_id, channel, status, sent_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    if (!decision.allowed) {
        insertDelivery.run(crypto.randomUUID(), notificationId, "IN_APP", "SUPPRESSED", null, now);
        // Notify UI so delivery log updates live
        emitToUser(user_id, "delivery_update", {
            notification_id: notificationId,
            status: "SUPPRESSED",
            reason: decision.reason,
        });
        return {
            status: 200,
            body: {
                status: "SUPPRESSED",
                reason: decision.reason,
                notification_id: notificationId,
            },
        };
    }

    const deliveries = [];

    for (const channel of decision.channels) {
        const tmpl = getActiveTemplate(setting.id, channel) || primaryTemplate;
        const channelRendered = tmpl ? renderTemplate(tmpl, { ...payload, severity }) : rendered;
        const deliveryId = crypto.randomUUID();

        const notificationPacket = {
            id: notificationId,
            delivery_id: deliveryId,
            event_key,
            category: setting.category,
            severity,
            channel,
            rendered_content: channelRendered,
            payload,
            is_read: false,
            created_at: now,
        };

        let status = "SENT";
        if (channel === "IN_APP") {
            const count = emitToUser(user_id, "in_app_notification", notificationPacket);
            status = count > 0 ? "DELIVERED" : "SENT";
        } else if (channel === "PUSH") {
            const count = emitToUser(user_id, "push_notification", notificationPacket);
            status = count > 0 ? "DELIVERED" : "SENT";
        }

        insertDelivery.run(deliveryId, notificationId, channel, status, now, now);
        deliveries.push({ id: deliveryId, channel, status });
    }

    return {
        status: 201,
        body: {
            status: "DISPATCHED",
            notification_id: notificationId,
            rendered_content: rendered,
            deliveries,
        },
    };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        // 1. SSE Real-Time Stream (IN_APP + PUSH channels)
        if (req.method === "GET" && url.pathname === "/api/v1/notifications/stream") {
            const userId = url.searchParams.get("user_id") || DEFAULT_USER;
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(`event: connected\ndata: ${JSON.stringify({ user_id: userId })}\n\n`);

            if (!sseClients.has(userId)) sseClients.set(userId, new Set());
            sseClients.get(userId).add(res);

            req.on("close", () => {
                sseClients.get(userId)?.delete(res);
            });
            return;
        }

        // 2. Internal Dispatch Endpoint (called by Server 1: Producer Server)
        if (req.method === "POST" && url.pathname === "/api/v1/internal/notifications/dispatch") {
            const body = await readJsonBody(req);
            const result = dispatchNotification(body);
            return sendJson(res, result.status, result.body);
        }

        // 3. In-App Inbox Feed
        if (req.method === "GET" && url.pathname === "/api/v1/notifications") {
            const userId = url.searchParams.get("user_id") || DEFAULT_USER;
            const tenantId = url.searchParams.get("tenant_id") || DEFAULT_TENANT;
            const unreadOnly = url.searchParams.get("unread_only") === "true";

            const rows = db
                .prepare(`
                    SELECT n.*, s.event_key, s.category
                    FROM notification n
                    JOIN notification_setting s ON s.id = n.setting_id
                    WHERE n.tenant_id = ? AND n.user_id = ?
                      ${unreadOnly ? "AND n.is_read = 0" : ""}
                    ORDER BY n.created_at DESC
                    LIMIT 50
                `)
                .all(tenantId, userId)
                .map((r) => ({
                    ...r,
                    payload: JSON.parse(r.payload),
                    rendered_content: JSON.parse(r.rendered_content),
                    is_read: Boolean(r.is_read),
                }));

            return sendJson(res, 200, { notifications: rows });
        }

        // 4. Unread Count
        if (req.method === "GET" && url.pathname === "/api/v1/notifications/unread-count") {
            const userId = url.searchParams.get("user_id") || DEFAULT_USER;
            const tenantId = url.searchParams.get("tenant_id") || DEFAULT_TENANT;
            const row = db
                .prepare(
                    "SELECT COUNT(*) as count FROM notification WHERE tenant_id = ? AND user_id = ? AND is_read = 0"
                )
                .get(tenantId, userId);
            return sendJson(res, 200, { unread_count: row.count });
        }

        // 5. Mark All Read
        if (req.method === "PATCH" && url.pathname === "/api/v1/notifications/read-all") {
            const userId = url.searchParams.get("user_id") || DEFAULT_USER;
            const tenantId = url.searchParams.get("tenant_id") || DEFAULT_TENANT;
            db.prepare(
                "UPDATE notification SET is_read = 1, read_at = datetime('now') WHERE tenant_id = ? AND user_id = ? AND is_read = 0"
            ).run(tenantId, userId);
            return sendJson(res, 200, { status: "ok" });
        }

        // 6. Mark Single Notification Read
        const readMatch = url.pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
        if (req.method === "PATCH" && readMatch) {
            db.prepare(
                "UPDATE notification SET is_read = 1, read_at = datetime('now') WHERE id = ?"
            ).run(readMatch[1]);
            return sendJson(res, 200, { status: "ok", id: readMatch[1] });
        }

        // 7. Get Merged User Settings
        if (req.method === "GET" && url.pathname === "/api/v1/notification-settings/me") {
            const userId = url.searchParams.get("user_id") || DEFAULT_USER;
            const tenantId = url.searchParams.get("tenant_id") || DEFAULT_TENANT;

            const settings = db.prepare("SELECT * FROM notification_setting ORDER BY category").all();
            const userRows = db
                .prepare("SELECT * FROM notification_user_setting WHERE tenant_id = ? AND user_id = ?")
                .all(tenantId, userId);
            const userMap = new Map(userRows.map((u) => [u.setting_id, u]));

            const merged = settings.map((s) => {
                const u = userMap.get(s.id);
                return {
                    setting_id: s.id,
                    event_key: s.event_key,
                    category: s.category,
                    description: s.description,
                    is_mandatory: Boolean(s.is_mandatory),
                    is_active: Boolean(s.is_active),
                    is_enabled: u ? Boolean(u.is_enabled) : true,
                    enabled_channels: u ? JSON.parse(u.enabled_channels) : JSON.parse(s.default_channels),
                    frequency: u ? u.frequency : "IMMEDIATE",
                    filter_conditions: u ? JSON.parse(u.filter_conditions) : JSON.parse(s.default_rules),
                };
            });

            return sendJson(res, 200, { settings: merged });
        }

        // 8. Update User Setting
        const settingMatch = url.pathname.match(/^\/api\/v1\/notification-settings\/me\/([^/]+)$/);
        if (req.method === "PUT" && settingMatch) {
            const settingId = settingMatch[1];
            const body = await readJsonBody(req);
            const userId = body.user_id || DEFAULT_USER;
            const tenantId = body.tenant_id || DEFAULT_TENANT;

            const validChannels = (body.enabled_channels || ["IN_APP"]).filter(
                (c) => c === "IN_APP" || c === "PUSH"
            );

            db.prepare(`
                INSERT INTO notification_user_setting
                    (id, user_id, tenant_id, setting_id, is_enabled, enabled_channels, frequency, filter_conditions, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(tenant_id, user_id, setting_id) DO UPDATE SET
                    is_enabled = excluded.is_enabled,
                    enabled_channels = excluded.enabled_channels,
                    frequency = excluded.frequency,
                    filter_conditions = excluded.filter_conditions,
                    updated_at = datetime('now')
            `).run(
                crypto.randomUUID(),
                userId,
                tenantId,
                settingId,
                body.is_enabled === false ? 0 : 1,
                JSON.stringify(validChannels),
                body.frequency || "IMMEDIATE",
                JSON.stringify(body.filter_conditions || {})
            );

            cache.del(`user_setting:${tenantId}:${userId}:${settingId}`);
            return sendJson(res, 200, { status: "updated", setting_id: settingId });
        }

        // 9. List Templates
        if (req.method === "GET" && url.pathname === "/api/v1/admin/notification-templates") {
            const templates = db
                .prepare(`
                    SELECT t.*, s.event_key
                    FROM notification_template t
                    JOIN notification_setting s ON s.id = t.setting_id
                    ORDER BY s.event_key, t.channel
                `)
                .all();
            return sendJson(res, 200, { templates });
        }

        // 10. Delivery Audit Log
        if (req.method === "GET" && url.pathname === "/api/v1/admin/deliveries") {
            const deliveries = db
                .prepare(`
                    SELECT d.*, n.severity, s.event_key
                    FROM notification_delivery d
                    JOIN notification n ON n.id = d.notification_id
                    JOIN notification_setting s ON s.id = n.setting_id
                    ORDER BY d.created_at DESC
                    LIMIT 50
                `)
                .all();
            return sendJson(res, 200, { deliveries });
        }

        // 11. Health Check
        if (req.method === "GET" && url.pathname === "/health") {
            return sendJson(res, 200, { status: "ok", service: "notification-server", port: PORT });
        }

        // Serve Frontend
        if (req.method === "GET") {
            return serveStaticFile(url.pathname, res);
        }

        res.writeHead(404);
        res.end("Not Found");
    } catch (err) {
        console.error("[Notification Server Error]", err);
        sendJson(res, 500, { error: err.message });
    }
});

// SSE Keep-alive heartbeat
setInterval(() => {
    for (const conns of sseClients.values()) {
        for (const res of conns) {
            res.write(": heartbeat\n\n");
        }
    }
}, 25_000);

server.listen(PORT, () => {
    console.log(`[Server 2] Notification Server + Frontend running at http://localhost:${PORT}`);
});
