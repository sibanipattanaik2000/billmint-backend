import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __billMintPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not configured. Please check the backend .env file.",
    );
  }

  return new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });
}

const prisma =
  global.__billMintPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__billMintPrisma = prisma;
}

export async function connectDatabase(
  retries = 5,
  delayMs = 3000,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.$connect();

      await prisma.$queryRaw`SELECT 1`;

      console.log(
        `[DATABASE] Connected successfully (${attempt}/${retries})`,
      );

      return;
    } catch (error) {
      lastError = error;

      console.error(
        `[DATABASE] Connection attempt ${attempt}/${retries} failed.`,
        error,
      );

      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, delayMs),
        );
      }
    }
  }

  throw new Error(
    `Unable to connect to PostgreSQL after ${retries} attempts. Last error: ${
      lastError instanceof Error
        ? lastError.message
        : String(lastError)
    }`,
  );
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    console.log("[DATABASE] Disconnected.");
  } catch (error) {
    console.error(
      "[DATABASE] Disconnect failed:",
      error,
    );
  }
}

export default prisma;
export { prisma };