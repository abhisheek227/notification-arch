const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

// Connected SSE clients
const clients = new Set();

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
};

function broadcastNotification(notification) {
    const payload = `event: notification\ndata: ${JSON.stringify(notification)}\n\n`;
    for (const res of clients) {
        res.write(payload);
    }
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

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // CORS headers for local dev flexibility
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    // SSE Endpoint
    if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        res.write(`event: connected\ndata: ${JSON.stringify({ message: "SSE connected" })}\n\n`);
        clients.add(res);

        req.on("close", () => {
            clients.delete(res);
        });
        return;
    }

    // Trigger / Publish Endpoint
    if (req.method === "POST" && url.pathname === "/notify") {
        try {
            const { title, message, type = "info" } = await readJsonBody(req);
            if (!title || !message) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Both 'title' and 'message' are required." }));
                return;
            }

            const allowedTypes = new Set(["info", "success", "warning", "error"]);
            const notification = {
                id: crypto.randomUUID(),
                title: String(title).trim(),
                message: String(message).trim(),
                type: allowedTypes.has(type) ? type : "info",
                createdAt: Date.now(),
            };

            broadcastNotification(notification);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ deliveredTo: clients.size, notification }));
        } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", clients: clients.size }));
        return;
    }

    // Serve frontend static files
    if (req.method === "GET") {
        serveStaticFile(url.pathname, res);
        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

// Keep-alive heartbeat every 25s
setInterval(() => {
    for (const res of clients) {
        res.write(": heartbeat\n\n");
    }
}, 25000);

server.listen(PORT, () => {
    console.log(`SSE Notification Server running at http://localhost:${PORT}`);
});
