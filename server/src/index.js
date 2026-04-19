const express = require("express");
const cors = require("cors");
const path = require("path");
const { initDB } = require("./utils/db");
const preflopRouter = require("./routes/preflop");
const sessionRouter = require("./routes/session");
const icmRouter = require("./routes/icm");
const analyzeRouter = require("./routes/analyze");

const app = express();
const PORT = process.env.PORT || 3001;

// Allow access from LAN devices
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" }));

// Init SQLite DB
initDB();

// Routes
app.use("/api/preflop", preflopRouter);
app.use("/api/session", sessionRouter);
app.use("/api/icm", icmRouter);
app.use("/api/analyze", express.json({ limit: "20mb" }), analyzeRouter);

app.get("/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GTO Server running on http://0.0.0.0:${PORT}`);
  console.log(`Access from LAN: http://<your-ip>:${PORT}`);
});
