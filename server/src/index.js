const express = require("express");
const cors = require("cors");
const path = require("path");
const { initDB } = require("./utils/db");
const preflopRouter = require("./routes/preflop");
const sessionRouter = require("./routes/session");

const app = express();
const PORT = process.env.PORT || 3001;

// Allow access from LAN devices
app.use(cors({ origin: "*" }));
app.use(express.json());

// Init SQLite DB
initDB();

// Routes
app.use("/api/preflop", preflopRouter);
app.use("/api/session", sessionRouter);

app.get("/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GTO Server running on http://0.0.0.0:${PORT}`);
  console.log(`Access from LAN: http://<your-ip>:${PORT}`);
});
