import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "path";

import routes from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import {
  connectDatabase,
  disconnectDatabase,
} from "./utils/prisma";

const app = express();

const PORT = parseInt(
  process.env.PORT || "4000",
  10,
);

const NODE_ENV =
  process.env.NODE_ENV || "development";

const CORS_ORIGIN =
  process.env.CORS_ORIGIN ||
  process.env.FRONTEND_URL ||
  "http://localhost:3000";

/* =========================================================
   SECURITY
========================================================= */

app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  }),
);

app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
    ],
  }),
);

/* =========================================================
   RATE LIMITING
========================================================= */

app.use(
  rateLimit({
    windowMs: parseInt(
      process.env.RATE_LIMIT_WINDOW_MS ||
        "900000",
      10,
    ),
    max: parseInt(
      process.env.RATE_LIMIT_MAX || "100",
      10,
    ),
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

/* =========================================================
   BODY PARSING
========================================================= */

app.use(
  express.json({
    limit: "10mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  }),
);

app.use(cookieParser());

/* =========================================================
   LOGGING
========================================================= */

app.use(
  morgan(
    NODE_ENV === "production"
      ? "combined"
      : "dev",
  ),
);

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  "/uploads",
  express.static(
    path.join(__dirname, "../uploads"),
  ),
);

/* =========================================================
   API
========================================================= */

app.use("/api", routes);

/* =========================================================
   404
========================================================= */

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(errorHandler);

/* =========================================================
   SERVER STARTUP
========================================================= */

async function startServer(): Promise<void> {
  try {
    console.log("");
    console.log(
      "==========================================",
    );
    console.log(
      "        BILLMINT BACKEND STARTING",
    );
    console.log(
      "==========================================",
    );
    console.log(`Environment: ${NODE_ENV}`);
    console.log(`Port: ${PORT}`);
    console.log("");

    /*
     * Database must be healthy before the API
     * starts accepting requests.
     */
    await connectDatabase();

    const server = app.listen(
      PORT,
      () => {
        console.log("");
        console.log(
          "==========================================",
        );
        console.log(
          "        BILLMINT API READY",
        );
        console.log(
          "==========================================",
        );
        console.log(
          `API:    http://localhost:${PORT}/api`,
        );
        console.log(
          `Health: http://localhost:${PORT}/api/health`,
        );
        console.log(
          "Database: Connected",
        );
        console.log(
          "==========================================",
        );
        console.log("");
      },
    );

    const shutdown = async (
      signal: string,
    ) => {
      console.log(
        `\n[SERVER] ${signal} received. Shutting down...`,
      );

      server.close(async () => {
        await disconnectDatabase();

        console.log(
          "[SERVER] Shutdown complete.",
        );

        process.exit(0);
      });

      setTimeout(() => {
        console.error(
          "[SERVER] Forced shutdown after timeout.",
        );

        process.exit(1);
      }, 10000).unref();
    };

    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
  } catch (error) {
    console.error("");
    console.error(
      "==========================================",
    );
    console.error(
      "       BILLMINT STARTUP FAILED",
    );
    console.error(
      "==========================================",
    );
    console.error(error);
    console.error(
      "==========================================",
    );
    console.error("");

    process.exit(1);
  }
}

void startServer();

export default app;