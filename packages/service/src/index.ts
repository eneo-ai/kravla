// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:http";
import pino from "pino";
import { loadConfigFromEnv } from "./config";
import { createApp } from "./app";

const config = loadConfigFromEnv();
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const { handler } = createApp(config, logger);

createServer(handler).listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      maxConcurrentCrawls: config.maxConcurrentCrawls,
      auth: config.apiKey !== null,
    },
    "kravla-service listening",
  );
});

// Optional bare-liveness listener for infra that probes a separate port.
if (config.healthPort !== null) {
  createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(config.healthPort, () => logger.info({ port: config.healthPort }, "healthz listening"));
}
