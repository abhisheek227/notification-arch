const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 4001;
const NOTIFICATION_SERVER_URL =
    process.env.NOTIFICATION_SERVER_URL || "http://localhost:4000";

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

async function forwardToNotificationServer(eventPayload) {
    const response = await fetch(
        `${NOTIFICATION_SERVER_URL}/api/v1/internal/notifications/dispatch`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(eventPayload),
        }
    );
    const data = await response.json();
    return { status: response.status, data };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        if (req.method === "GET" && url.pathname === "/health") {
            return sendJson(res, 200, {
                status: "ok",
                service: "producer-trigger-server",
                port: PORT,
                target_notification_server: NOTIFICATION_SERVER_URL,
            });
        }

        // Generic trigger endpoint
        if (req.method === "POST" && url.pathname === "/trigger") {
            const body = await readJsonBody(req);
            const event = {
                event_key: body.event_key || "vuln.found",
                tenant_id: body.tenant_id || "tenant-1",
                user_id: body.user_id || "user-1",
                severity: body.severity || "HIGH",
                payload: body.payload || {},
                idempotency_key: body.idempotency_key || crypto.randomUUID(),
            };
            const result = await forwardToNotificationServer(event);
            return sendJson(res, result.status, {
                triggered_by: "producer-server (port 4001)",
                forwarded_to: NOTIFICATION_SERVER_URL,
                result: result.data,
            });
        }

        // Preset 1: Vulnerability Found
        if (req.method === "POST" && url.pathname === "/trigger/vulnerability") {
            const body = await readJsonBody(req);
            const event = {
                event_key: "vuln.found",
                tenant_id: body.tenant_id || "tenant-1",
                user_id: body.user_id || "user-1",
                severity: body.severity || "CRITICAL",
                payload: {
                    asset: body.asset || "api.psynetra.io",
                    vuln_name: body.vuln_name || "SQL Injection",
                    cve: body.cve || "CVE-2026-1042",
                    scan_id: body.scan_id || `SCN-${Math.floor(1000 + Math.random() * 9000)}`,
                    vuln_count: body.vuln_count ?? 1,
                },
                idempotency_key: body.idempotency_key || crypto.randomUUID(),
            };
            const result = await forwardToNotificationServer(event);
            return sendJson(res, result.status, {
                triggered_by: "producer-server (port 4001)",
                result: result.data,
            });
        }

        // Preset 2: Scan Completed
        if (req.method === "POST" && url.pathname === "/trigger/scan-completed") {
            const body = await readJsonBody(req);
            const vulnCount = body.vuln_count ?? 0;
            const event = {
                event_key: "scan.completed",
                tenant_id: body.tenant_id || "tenant-1",
                user_id: body.user_id || "user-1",
                severity: vulnCount > 0 ? "MEDIUM" : "INFO",
                payload: {
                    asset: body.asset || "app.psynetra.io",
                    scan_id: body.scan_id || `SCN-${Math.floor(1000 + Math.random() * 9000)}`,
                    duration: body.duration || "42s",
                    vuln_count: vulnCount,
                },
                idempotency_key: body.idempotency_key || crypto.randomUUID(),
            };
            const result = await forwardToNotificationServer(event);
            return sendJson(res, result.status, {
                triggered_by: "producer-server (port 4001)",
                result: result.data,
            });
        }

        // Preset 3: Mandatory Auth New Login
        if (req.method === "POST" && url.pathname === "/trigger/auth-login") {
            const body = await readJsonBody(req);
            const event = {
                event_key: "auth.new_login",
                tenant_id: body.tenant_id || "tenant-1",
                user_id: body.user_id || "user-1",
                severity: "HIGH",
                payload: {
                    device: body.device || "Chrome on Linux",
                    location: body.location || "Bengaluru, IN",
                    ip: body.ip || "103.21.244.12",
                },
                idempotency_key: body.idempotency_key || crypto.randomUUID(),
            };
            const result = await forwardToNotificationServer(event);
            return sendJson(res, result.status, {
                triggered_by: "producer-server (port 4001)",
                result: result.data,
            });
        }

        res.writeHead(404);
        res.end("Not Found");
    } catch (err) {
        console.error("[Producer Server Error]", err.message);
        sendJson(res, 502, {
            error: "Failed to reach Notification Server",
            details: err.message,
        });
    }
});

server.listen(PORT, () => {
    console.log(`[Server 1] Producer / Trigger Server running at http://localhost:${PORT}`);
    console.log(`           Dispatching events -> ${NOTIFICATION_SERVER_URL}`);
});
