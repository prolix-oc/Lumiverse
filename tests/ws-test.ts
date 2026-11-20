// Quick WebSocket test
const ws = new WebSocket("ws://localhost:7860/ws");

const events: string[] = [];

ws.onopen = () => {
  console.log("Connected");
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  events.push(data.event);
  console.log("Event:", JSON.stringify(data, null, 2));

  // After receiving CONNECTED, do a settings update to trigger SETTINGS_UPDATED
  if (data.event === "CONNECTED") {
    fetch("http://localhost:7860/api/v1/settings/ws_test", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "testing_ws" }),
    }).then(() => {
      // Give a moment for the WS event to arrive
      setTimeout(() => {
        console.log("\nAll events received:", events);
        if (events.includes("CONNECTED") && events.includes("SETTINGS_UPDATED")) {
          console.log("SUCCESS: WebSocket events working correctly");
        } else {
          console.log("FAIL: Expected CONNECTED and SETTINGS_UPDATED events");
        }
        ws.close();
        process.exit(0);
      }, 500);
    });
  }
};

ws.onerror = (err) => {
  console.error("WS Error:", err);
  process.exit(1);
};

// Timeout after 5s
setTimeout(() => {
  console.error("Timeout waiting for events");
  process.exit(1);
}, 5000);
