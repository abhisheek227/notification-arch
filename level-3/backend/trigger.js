// Helper script to push a notification to the SSE backend.
// Usage: node trigger.js "Title" "Message" [info|success|warning|error]

const PORT = process.env.PORT || 3000;
const [, , title = "Server Ping", message = "Hello from trigger.js!", type = "info"] = process.argv;

async function sendNotification() {
    try {
        const res = await fetch(`http://localhost:${PORT}/notify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, message, type }),
        });
        const data = await res.json();
        if (!res.ok) {
            console.error("Failed:", data);
            process.exit(1);
        }
        console.log(`Delivered to ${data.deliveredTo} client(s):`, data.notification);
    } catch (err) {
        console.error("Could not reach server. Is server.js running?", err.message);
        process.exit(1);
    }
}

sendNotification();
