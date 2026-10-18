
import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { AppError } from "../middleware/errorHandler";

const DEFAULT_SHELVES = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "Z",
  "H",
  "ZR",
  "R",
] as const;


function parsePositiveQuantity(value: unknown): Prisma.Decimal {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "") ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new AppError("Quantity must be a positive number", 400);
  }

  let quantity: Prisma.Decimal;

  try {
    quantity = new Prisma.Decimal(value);
  } catch {
    throw new AppError("Quantity must be a valid number", 400);
  }

  if (!quantity.isFinite() || quantity.lte(0)) {
    throw new AppError("Quantity must be a positive number", 400);
  }

  return quantity;
}


/**
 * Create any missing default shelves without duplicating existing ones.
 */
export async function listShelves(businessId: string) {
  await prisma.$transaction(
    DEFAULT_SHELVES.map((name) =>
      prisma.shelfLocation.upsert({
        where: {
          businessId_name: { businessId, name },
        },
        create: { businessId, name },
        update: {},
      }),
    ),
  );

  return prisma.shelfLocation.findMany({
    where: { businessId },
    include: {
      _count: { select: { stocks: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Show products stored on one shelf.
 */
export async function getShelfStock(
  businessId: string,
  shelfId: string,
) {
  const shelf = await prisma.shelfLocation.findFirst({
    where: { id: shelfId, businessId },
    select: { id: true, name: true, isActive: true },
  });

  if (!shelf) {
    throw new AppError("Shelf not found", 404);
  }

  const stocks = await prisma.shelfStock.findMany({
    where: { businessId, shelfId },
    include: {
      item: {
        select: {
          id: true,
          name: true,
          sku: true,
          barcode: true,
          currentStock: true,
          minimumStock: true,
          unit: {
            select: { name: true, shortName: true },
          },
        },
      },
    },
    orderBy: { item: { name: "asc" } },
  });

  return { shelf, stocks };
}

/**
 * Place some of an item's existing inventory onto a shelf.
 * This does not increase the item's overall currentStock.
 */

export async function placeStockOnShelf(
  businessId: string,
  shelfId: string,
  itemId: string,
  rawQuantity: unknown,
  userId?: string,
) {
  const quantity = parsePositiveQuantity(rawQuantity);

  try {
    return await prisma.$transaction(
      async (tx) => {
        const shelf = await tx.shelfLocation.findFirst({
          where: { id: shelfId, businessId, isActive: true },
          select: { id: true, name: true },
        });

        if (!shelf) {
          throw new AppError("Active shelf not found", 404);
        }

        const item = await tx.item.findFirst({
          where: {
            id: itemId,
            businessId,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: {
            id: true,
            name: true,
            currentStock: true,
          },
        });

        if (!item) {
          throw new AppError("Active item not found", 404);
        }

        const allocated = await tx.shelfStock.aggregate({
          where: { businessId, itemId },
          _sum: { quantity: true },
        });

        const alreadyAllocated =
          allocated._sum.quantity ?? new Prisma.Decimal(0);

        if (alreadyAllocated.plus(quantity).gt(item.currentStock)) {
          throw new AppError(
            "Shelf allocation cannot exceed the item's available overall stock",
            409,
          );
        }

        const stock = await tx.shelfStock.upsert({
          where: {
            shelfId_itemId: { shelfId, itemId },
          },
          create: {
            businessId,
            shelfId,
            itemId,
            quantity,
          },
          update: {
            quantity: { increment: quantity },
          },
        });

        await tx.shelfMovement.create({
          data: {
            businessId,
            itemId,
            toShelfId: shelfId,
            quantity,
            movementType: "PLACEMENT",
            reason: "Stock placed on shelf",
            createdById: userId,
          },
        });

        return { shelf, item, stock };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      throw new AppError(
        "Shelf stock changed concurrently. Please retry",
        409,
      );
    }

    throw error;
  }
}


/**
 * Transfer stock between shelves. Overall item stock stays unchanged.
 */
export async function transferShelfStock(
  businessId: string,
  itemId: string,
  fromShelfId: string,
  toShelfId: string,
  rawQuantity: unknown,
  reason?: string,
  userId?: string,
) {
  const quantity = parsePositiveQuantity(rawQuantity);

  if (fromShelfId === toShelfId) {
    throw new AppError("Choose two different shelves", 400);
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const shelves = await tx.shelfLocation.findMany({
          where: {
            businessId,
            isActive: true,
            id: { in: [fromShelfId, toShelfId] },
          },
          select: { id: true, name: true },
        });

        if (shelves.length !== 2) {
          throw new AppError(
            "One or both active shelves were not found",
            404,
          );
        }

        const item = await tx.item.findFirst({
          where: {
            id: itemId,
            businessId,
            deletedAt: null,
            status: "ACTIVE",
          },
          select: { id: true, name: true },
        });

        if (!item) {
          throw new AppError("Active item not found", 404);
        }

        const source = await tx.shelfStock.findUnique({
          where: {
            shelfId_itemId: {
              shelfId: fromShelfId,
              itemId,
            },
          },
          select: { id: true, quantity: true },
        });

        if (!source || source.quantity.lt(quantity)) {
          throw new AppError(
            "Insufficient quantity on the source shelf",
            409,
          );
        }

        const updatedSource = await tx.shelfStock.updateMany({
          where: {
            id: source.id,
            businessId,
            quantity: { gte: quantity },
          },
          data: { quantity: { decrement: quantity } },
        });

        if (updatedSource.count !== 1) {
          throw new AppError(
            "Shelf stock changed concurrently. Please retry",
            409,
          );
        }

        const destination = await tx.shelfStock.upsert({
          where: {
            shelfId_itemId: {
              shelfId: toShelfId,
              itemId,
            },
          },
          create: {
            businessId,
            shelfId: toShelfId,
            itemId,
            quantity,
          },
          update: { quantity: { increment: quantity } },
        });

        await tx.shelfMovement.create({
          data: {
            businessId,
            itemId,
            fromShelfId,
            toShelfId,
            quantity,
            movementType: "TRANSFER",
            reason: reason?.trim() || "Shelf-to-shelf transfer",
            createdById: userId,
          },
        });

        return {
          item,
          fromShelf: shelves.find((s) => s.id === fromShelfId),
          toShelf: shelves.find((s) => s.id === toShelfId),
          remainingOnSource: source.quantity.minus(quantity),
          destination,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034"
    ) {
      throw new AppError(
        "Shelf stock changed concurrently. Please retry",
        409,
      );
    }

    throw error;
  }
}
